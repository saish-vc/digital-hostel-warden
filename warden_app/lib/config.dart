import 'package:flutter/foundation.dart';

/// Single source of truth for the backend address, mirroring the student app.
///
/// Override per build:
///   flutter build apk --dart-define=API_BASE_URL=https://as7us.tailc07926.ts.net
class AppConfig {
  const AppConfig._();

  static const bool hasApiBase = bool.hasEnvironment('API_BASE_URL');

  static const apiBase = String.fromEnvironment(
    'API_BASE_URL',
    // Emulator loopback. Debug-only convenience: release builds must pass an
    // explicit https URL (checked in main.dart).
    defaultValue: 'http://10.0.2.2:3001',
  );

  static String get socketUrl => apiBase
      .replaceFirst('https://', 'wss://')
      .replaceFirst('http://', 'ws://');

  static const appName = 'HostelGuard Warden';
  static const version = '1.0.0';

  /// Demo credentials, only offered in debug builds.
  static const demoEmail = 'warden@hostel.local';
  static const demoPassword = 'password123';

  static bool get showDemoHint => kDebugMode;
}
