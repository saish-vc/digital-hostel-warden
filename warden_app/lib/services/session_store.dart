import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'api.dart';

class StoredSession {
  const StoredSession({required this.token, required this.user});

  final String token;
  final SessionUser user;
}

/// The JWT is a bearer credential, so it lives in Android Keystore-backed
/// storage. Only the display name and role go to SharedPreferences.
class SessionStore {
  static const _tokenKey = 'warden.token';
  static const _userKey = 'warden.user';

  final FlutterSecureStorage _secure = const FlutterSecureStorage();

  Future<StoredSession?> read() async {
    final token = await _secure.read(key: _tokenKey);
    if (token == null || token.isEmpty) return null;
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getString(_userKey);
    SessionUser user = const SessionUser(id: '', name: 'Warden', role: 'WARDEN');
    if (raw != null && raw.isNotEmpty) {
      try {
        final decoded = jsonDecode(raw);
        if (decoded is Map) {
          user = SessionUser.fromJson(decoded.cast<String, dynamic>());
        }
      } on FormatException {
        // Keep the placeholder; the token is what authenticates.
      }
    }
    return StoredSession(token: token, user: user);
  }

  Future<void> save(String token, SessionUser user) async {
    await _secure.write(key: _tokenKey, value: token);
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_userKey, jsonEncode(user.toJson()));
  }

  Future<void> clear() async {
    await _secure.delete(key: _tokenKey);
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_userKey);
  }
}
