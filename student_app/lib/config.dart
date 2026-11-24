/// Single source of truth for the backend address.
///
/// Override per build, e.g. the public tunnel:
///   flutter run --dart-define=API_BASE_URL=https://api.yourdomain.com
class AppConfig {
  static const apiBase = String.fromEnvironment(
    'API_BASE_URL',
    defaultValue: 'http://10.0.2.2:3001', // emulator loopback
  );

  static String get socketUrl => apiBase
      .replaceFirst('https://', 'wss://')
      .replaceFirst('http://', 'ws://');
}
