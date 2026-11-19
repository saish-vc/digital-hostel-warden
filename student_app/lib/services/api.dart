import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

/// Android emulator reaches the host machine through 10.0.2.2.
/// For a physical device or iOS simulator, override it:
///   flutter run --dart-define=API_URL=http://192.168.1.20:4000
const String kApiBaseUrl = String.fromEnvironment(
  'API_URL',
  defaultValue: 'http://10.0.2.2:4000',
);

class ApiException implements Exception {
  ApiException(this.message, {this.statusCode, this.retryAfterSeconds});

  final String message;
  final int? statusCode;

  /// Seconds to wait before re-enabling the SOS button (from the 429
  /// body's `retryAfter`). UI code uses it to schedule the cooldown timer.
  final int? retryAfterSeconds;

  @override
  String toString() => message;
}

class ApiService {
  static const _tokenKey = 'token';
  static const _userIdKey = 'userId';
  static const _userNameKey = 'userName';

  static Future<String?> get token async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getString(_tokenKey);
  }

  static Future<Map<String, dynamic>> login(String email, String password) async {
    final response = await http.post(
      Uri.parse('$kApiBaseUrl/auth/login'),
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({
        'email': email,
        'password': password,
        'role': 'STUDENT',
      }),
    );

    final body = _decode(response);

    if (response.statusCode != 200) {
      throw ApiException(
        body['error']?.toString() ?? 'Login failed',
        statusCode: response.statusCode,
      );
    }

    final user = Map<String, dynamic>.from(body['user'] as Map);

    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_tokenKey, body['token'] as String);
    await prefs.setString(_userIdKey, user['id'] as String);
    await prefs.setString(_userNameKey, user['name'] as String);

    return user;
  }

  /// Sends an SOS. Location is optional; a GPS failure must never block it.
  static Future<Map<String, dynamic>> createAlert(
    String type, {
    double? latitude,
    double? longitude,
    double? locationAccuracy,
  }) async {
    final token = await ApiService.token;

    if (token == null) {
      throw ApiException('Not logged in');
    }

    final payload = <String, dynamic>{'type': type};
    if (latitude != null && longitude != null) {
      payload['latitude'] = latitude;
      payload['longitude'] = longitude;
      if (locationAccuracy != null) {
        payload['locationAccuracy'] = locationAccuracy;
      }
    }

    final response = await http.post(
      Uri.parse('$kApiBaseUrl/alerts'),
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer $token',
      },
      body: jsonEncode(payload),
    );

    final body = _decode(response);

    if (response.statusCode != 200 && response.statusCode != 201) {
      // Rate-limited (429): the SOS limiter tripped. Per the hardening
      // stage's UX decision this is NOT an error for the student — the
      // warden already received the first alerts, and the backend logged
      // sos_rate_limit_overridden. Reassure instead of alarming; surface
      // the server-provided retryAfter so the button can un-disable.
      if (response.statusCode == 429 && body['error'] == 'rate_limited') {
        throw ApiException(
          "You've sent several alerts — the warden is on the way",
          statusCode: 429,
          retryAfterSeconds: body['retryAfter'] is int
              ? body['retryAfter'] as int
              : int.tryParse('${body['retryAfter'] ?? ''}'),
        );
      }

      throw ApiException(
        body['error']?.toString() ?? 'Could not send the alert',
        statusCode: response.statusCode,
      );
    }

    return body;
  }

  // ---------------------------------------------------------------------
  // Leave requests & gate passes
  // ---------------------------------------------------------------------

  /// Shared request path for the leave endpoints: one auth header, one error
  /// shape (`{ error }` from the backend), one place to unwrap list bodies
  /// (`_decode` wraps a JSON array as `{ data: [...] }`).
  static Future<Map<String, dynamic>> _send(
    String method,
    String path, {
    Map<String, dynamic>? body,
  }) async {
    final token = await ApiService.token;
    if (token == null) {
      throw ApiException('Not logged in');
    }

    final uri = Uri.parse('$kApiBaseUrl$path');
    final headers = <String, String>{
      'Content-Type': 'application/json',
      'Authorization': 'Bearer $token',
    };

    final http.Response response;
    if (method == 'POST') {
      response = await http.post(uri, headers: headers, body: jsonEncode(body ?? {}));
    } else if (method == 'PATCH') {
      response = await http.patch(uri, headers: headers, body: jsonEncode(body ?? {}));
    } else if (method == 'DELETE') {
      response = await http.delete(uri, headers: headers);
    } else {
      response = await http.get(uri, headers: headers);
    }

    final decoded = _decode(response);

    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw ApiException(
        decoded['error']?.toString() ?? 'Could not reach the hostel server',
        statusCode: response.statusCode,
      );
    }

    return decoded;
  }

  static Future<Map<String, dynamic>> createLeave({
    required String type,
    required String reason,
    required String destination,
    String? emergencyContact,
    required DateTime departureTime,
    required DateTime expectedReturn,
  }) {
    return _send('POST', '/leaves', body: {
      'type': type,
      'reason': reason,
      'destination': destination,
      if (emergencyContact != null && emergencyContact.trim().isNotEmpty)
        'emergencyContact': emergencyContact.trim(),
      'departureTime': departureTime.toUtc().toIso8601String(),
      'expectedReturn': expectedReturn.toUtc().toIso8601String(),
    });
  }

  static Future<List<Map<String, dynamic>>> myLeaves() async {
    final body = await _send('GET', '/leaves/my');
    final raw = body['data'];
    if (raw is! List) return const [];
    return raw
        .whereType<Map>()
        .map((item) => Map<String, dynamic>.from(item))
        .toList(growable: false);
  }

  static Future<Map<String, dynamic>> leavePass(String leaveId) {
    return _send('GET', '/leaves/$leaveId/pass');
  }

  static Future<Map<String, dynamic>> cancelLeave(String leaveId) {
    return _send('DELETE', '/leaves/$leaveId');
  }

  /// Off-campus SOS. Location is optional, exactly like the on-campus button:
  /// a GPS failure must never stop the alert.
  static Future<Map<String, dynamic>> leaveEmergency(
    String leaveId, {
    double? latitude,
    double? longitude,
    double? locationAccuracy,
  }) {
    final payload = <String, dynamic>{};
    if (latitude != null && longitude != null) {
      payload['latitude'] = latitude;
      payload['longitude'] = longitude;
      if (locationAccuracy != null) {
        payload['locationAccuracy'] = locationAccuracy;
      }
    }
    return _send('POST', '/leaves/$leaveId/emergency', body: payload);
  }

  static Future<String?> userName() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getString(_userNameKey);
  }

  static Future<void> logout() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_tokenKey);
    await prefs.remove(_userIdKey);
    await prefs.remove(_userNameKey);
  }

  static Map<String, dynamic> _decode(http.Response response) {
    try {
      final decoded = jsonDecode(response.body);
      if (decoded is Map<String, dynamic>) return decoded;
      return {'data': decoded};
    } catch (_) {
      return {'error': 'Unexpected server response'};
    }
  }
}
