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
