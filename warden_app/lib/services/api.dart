import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:http/http.dart' as http;

import '../config.dart';
import '../models/alert.dart';
import '../models/history.dart';
import '../models/leave.dart';
import '../models/paging.dart';

class ApiException implements Exception {
  ApiException(
    this.message, {
    this.statusCode,
    this.code,
    this.retryAfterSeconds,
  });

  final String message;
  final int? statusCode;

  /// Machine-readable code when the server sends one
  /// (`invalid_transition`, `rate_limited`, `escalation_status_unavailable`).
  final String? code;

  /// Seconds to wait, from a 429 body or the `Retry-After` header.
  final int? retryAfterSeconds;

  bool get isUnauthorized => statusCode == 401;
  bool get isConflict => statusCode == 409;
  bool get isRateLimited => statusCode == 429;

  @override
  String toString() => message;
}

class SessionUser {
  const SessionUser({required this.id, required this.name, required this.role});

  final String id;
  final String name;
  final String role;

  factory SessionUser.fromJson(Map<String, dynamic> json) => SessionUser(
        id: json['id']?.toString() ?? '',
        name: json['name']?.toString() ?? '',
        role: json['role']?.toString() ?? '',
      );

  Map<String, dynamic> toJson() => {'id': id, 'name': name, 'role': role};
}

class LoginResult {
  const LoginResult({required this.token, required this.user});

  final String token;
  final SessionUser user;
}

class ApiClient {
  ApiClient({required this.tokenProvider, this.onUnauthorized});

  final String? Function() tokenProvider;
  final void Function()? onUnauthorized;

  final http.Client _client = http.Client();
  static const Duration _timeout = Duration(seconds: 15);
  static const Set<String> _knownCodes = {
    'invalid_transition',
    'rate_limited',
    'escalation_status_unavailable',
  };

  String get _base => AppConfig.apiBase.replaceAll(RegExp(r'/+$'), '');

  Uri _uri(String path, [Map<String, String?>? query]) {
    final base = Uri.parse('$_base$path');
    if (query == null) return base;
    final params = <String, String>{};
    query.forEach((key, value) {
      if (value != null && value.isNotEmpty) params[key] = value;
    });
    return params.isEmpty ? base : base.replace(queryParameters: params);
  }

  Map<String, String> _headers({bool json = false}) {
    final headers = <String, String>{'Accept': 'application/json'};
    if (json) headers['Content-Type'] = 'application/json';
    final token = tokenProvider();
    if (token != null && token.isNotEmpty) {
      headers['Authorization'] = 'Bearer $token';
    }
    return headers;
  }

  Future<dynamic> _request(
    String method,
    String path, {
    Map<String, dynamic>? body,
    Map<String, String?>? query,
    bool skipAuthHandler = false,
  }) async {
    final uri = _uri(path, query);
    final headers = _headers(json: body != null);
    final payload = body == null ? null : jsonEncode(body);
    http.Response response;
    try {
      if (method == 'GET') {
        response = await _client.get(uri, headers: headers).timeout(_timeout);
      } else if (method == 'POST') {
        response = await _client
            .post(uri, headers: headers, body: payload)
            .timeout(_timeout);
      } else if (method == 'PATCH') {
        response = await _client
            .patch(uri, headers: headers, body: payload)
            .timeout(_timeout);
      } else if (method == 'DELETE') {
        response = await _client
            .delete(uri, headers: headers, body: payload)
            .timeout(_timeout);
      } else {
        throw ApiException('Unsupported method $method');
      }
    } on TimeoutException {
      throw ApiException('The request timed out. Check your connection.');
    } on SocketException {
      throw ApiException('No network connection.');
    } on http.ClientException catch (error) {
      throw ApiException('Network error: ${error.message}');
    }

    if (response.statusCode >= 200 && response.statusCode < 300) {
      if (response.body.isEmpty) return null;
      try {
        return jsonDecode(response.body);
      } on FormatException {
        throw ApiException('Unexpected response from the server.');
      }
    }

    final error = _decodeError(response);
    if (response.statusCode == 401 && !skipAuthHandler) {
      onUnauthorized?.call();
    }
    throw error;
  }

  Future<String> _requestText(
    String path, {
    Map<String, String?>? query,
  }) async {
    final uri = _uri(path, query);
    http.Response response;
    try {
      response = await _client
          .get(uri, headers: {..._headers(), 'Accept': 'text/csv'})
          .timeout(_timeout);
    } on TimeoutException {
      throw ApiException('The export timed out. Try a narrower date range.');
    } on SocketException {
      throw ApiException('No network connection.');
    } on http.ClientException catch (error) {
      throw ApiException('Network error: ${error.message}');
    }
    if (response.statusCode >= 200 && response.statusCode < 300) {
      return response.body;
    }
    throw _decodeError(response);
  }

  ApiException _decodeError(http.Response response) {
    var message = 'Request failed (${response.statusCode}).';
    String? code;
    int? retryAfter;
    try {
      final decoded = jsonDecode(response.body);
      if (decoded is Map) {
        final raw = decoded['error'];
        if (raw is String && raw.isNotEmpty) {
          message = raw;
          if (_knownCodes.contains(raw)) code = raw;
        }
        final retry = decoded['retryAfter'];
        if (retry is num) retryAfter = retry.toInt();
      }
    } on FormatException {
      // Non-JSON error page; keep the generic message.
    }
    retryAfter ??= int.tryParse(response.headers['retry-after'] ?? '');
    if (response.statusCode == 401) message = 'Session expired. Sign in again.';
    return ApiException(
      message,
      statusCode: response.statusCode,
      code: code,
      retryAfterSeconds: retryAfter,
    );
  }

  Map<String, dynamic> _map(dynamic value) {
    if (value is Map<String, dynamic>) return value;
    if (value is Map) return value.cast<String, dynamic>();
    throw ApiException('Unexpected response from the server.');
  }

  Future<LoginResult> login(String email, String password) async {
    final decoded = await _request(
      'POST',
      '/auth/login',
      body: {'email': email.trim(), 'password': password, 'role': 'WARDEN'},
      skipAuthHandler: true,
    );
    final json = _map(decoded);
    final token = json['token'];
    if (token is! String || token.isEmpty) {
      throw ApiException('Login response did not include a token.');
    }
    return LoginResult(
      token: token,
      user: SessionUser.fromJson(_map(json['user'])),
    );
  }

  Future<List<Alert>> fetchAlerts({String? status, int limit = 500}) async {
    final decoded = await _request('GET', '/alerts', query: {
      'status': status,
      'limit': '$limit',
    });
    if (decoded is! List) {
      throw ApiException('Unexpected alert list from the server.');
    }
    return decoded
        .whereType<Map>()
        .map((row) => Alert.fromJson(row.cast<String, dynamic>()))
        .toList(growable: false);
  }

  Future<Alert> acknowledgeAlert(String id) async {
    final decoded = await _request('PATCH', '/alerts/$id/acknowledge');
    return Alert.fromJson(_map(decoded));
  }

  Future<Alert> resolveAlert(String id, String note) async {
    final decoded = await _request(
      'PATCH',
      '/alerts/$id/resolve',
      body: {'resolutionNote': note.trim()},
    );
    return Alert.fromJson(_map(decoded));
  }

  Future<HistoryPage> fetchHistory({
    int page = 1,
    int limit = 25,
    String? status,
    DateTime? from,
    DateTime? to,
    String? studentName,
  }) async {
    final decoded = await _request('GET', '/alerts/history', query: {
      'page': '$page',
      'limit': '$limit',
      'status': status,
      'from': from == null ? null : isoUtcOf(from),
      'to': to == null ? null : isoUtcOf(to),
      'studentName': studentName?.trim(),
    });
    return ApiPage.fromJson(_map(decoded), HistoryRow.fromJson);
  }

  Future<String> fetchHistoryCsv({
    String? status,
    DateTime? from,
    DateTime? to,
    String? studentName,
  }) {
    return _requestText('/alerts/history.csv', query: {
      'page': '1',
      'limit': '100',
      'status': status,
      'from': from == null ? null : isoUtcOf(from),
      'to': to == null ? null : isoUtcOf(to),
      'studentName': studentName?.trim(),
    });
  }

  Future<Map<String, dynamic>> escalationStatus(String id) async {
    return _map(await _request('GET', '/alerts/$id/escalation-status'));
  }

  Future<LeaveStats> fetchLeaveStats() async {
    return LeaveStats.fromJson(_map(await _request('GET', '/leaves/stats')));
  }

  Future<ApiPage<Leave>> fetchLeaves({
    int page = 1,
    int limit = 100,
    String? status,
    String? type,
    String? studentName,
    DateTime? from,
    DateTime? to,
  }) async {
    final decoded = await _request('GET', '/leaves', query: {
      'page': '$page',
      'limit': '$limit',
      'status': status,
      'type': type,
      'studentName': studentName?.trim(),
      'from': from == null ? null : isoUtcOf(from),
      'to': to == null ? null : isoUtcOf(to),
    });
    return ApiPage.fromJson(_map(decoded), Leave.fromJson);
  }

  Future<List<Leave>> fetchActiveLeaves() async {
    final decoded = await _request('GET', '/leaves/active');
    return _leaveList(decoded);
  }

  Future<List<Leave>> fetchOverdueLeaves() async {
    final decoded = await _request('GET', '/leaves/overdue');
    return _leaveList(decoded);
  }

  List<Leave> _leaveList(dynamic decoded) {
    if (decoded is! List) {
      throw ApiException('Unexpected leave list from the server.');
    }
    return decoded
        .whereType<Map>()
        .map((row) => Leave.fromJson(row.cast<String, dynamic>()))
        .toList(growable: false);
  }

  Future<Leave> reviewLeave(
    String id,
    String status, {
    String? remarks,
  }) async {
    final decoded = await _request(
      'PATCH',
      '/leaves/$id/review',
      body: {
        'status': status,
        if (remarks != null && remarks.trim().isNotEmpty)
          'reviewRemarks': remarks.trim(),
      },
    );
    return Leave.fromJson(_map(decoded));
  }

  Future<Leave> gateDeparture(String id, String code) async {
    final decoded = await _request(
      'POST',
      '/leaves/$id/gate-departure',
      body: {'gatePassCode': code.trim().toUpperCase()},
    );
    return Leave.fromJson(_map(decoded));
  }

  Future<Leave> gateReturn(String id) async {
    final decoded = await _request('POST', '/leaves/$id/gate-return');
    return Leave.fromJson(_map(decoded));
  }

  Future<void> registerDeviceToken(String token, String userAgent) async {
    await _request('POST', '/wardens/fcm-token', body: {
      'token': token,
      'userAgent': userAgent,
    });
  }

  Future<void> unregisterDeviceToken(String token) async {
    await _request('DELETE', '/wardens/fcm-token', body: {'token': token});
  }

  void close() => _client.close();
}

/// Local helper so the API layer does not depend on UI formatting.
String isoUtcOf(DateTime value) => value.toUtc().toIso8601String();
