import 'package:flutter/material.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';

/// Owns the Android notification channel and the tray entry.
///
/// The channel must exist at max importance *before* FCM delivers anything:
/// FCM cannot raise the importance of a channel it auto-creates. The same
/// channel is used for foreground local notifications so the sound and
/// heads-up behaviour match a background delivery.
class NotificationService {
  const NotificationService._();

  static const channelId = 'warden_alerts';
  static const channelName = 'Emergency alerts';
  static const channelDescription = 'SOS alerts from hostel students';

  static final FlutterLocalNotificationsPlugin _plugin =
      FlutterLocalNotificationsPlugin();

  static bool _ready = false;
  static void Function(String alertId)? _onTap;

  static bool get isReady => _ready;

  static Future<void> init({
    required void Function(String alertId) onTap,
  }) async {
    _onTap = onTap;
    const android = AndroidInitializationSettings('@drawable/ic_stat_alert');
    const settings = InitializationSettings(android: android);
    await _plugin.initialize(
      settings,
      onDidReceiveNotificationResponse: (response) {
        final payload = response.payload;
        if (payload != null && payload.isNotEmpty) _onTap?.call(payload);
      },
    );
    await _createChannel();
    _ready = true;
  }

  /// Used by the top-level FCM background handler, which runs in its own
  /// isolate. It has no UI callback, so taps are handled by the main isolate
  /// through `getInitialMessage`/`onMessageOpenedApp` instead.
  static Future<void> initBackground() async {
    if (_ready) return;
    const android = AndroidInitializationSettings('@drawable/ic_stat_alert');
    const settings = InitializationSettings(android: android);
    await _plugin.initialize(settings);
    await _createChannel();
    _ready = true;
  }

  static Future<void> _createChannel() async {
    final androidPlugin = _plugin.resolvePlatformSpecificImplementation<
        AndroidFlutterLocalNotificationsPlugin>();
    await androidPlugin?.createNotificationChannel(
      const AndroidNotificationChannel(
        channelId,
        channelName,
        description: channelDescription,
        importance: Importance.max,
        playSound: true,
        enableVibration: true,
        showBadge: true,
        enableLights: true,
        ledColor: Color(0xFFDC2626),
        audioAttributesUsage: AudioAttributesUsage.alarm,
      ),
    );
  }

  static Future<bool> requestPermission() async {
    final android = _plugin.resolvePlatformSpecificImplementation<
        AndroidFlutterLocalNotificationsPlugin>();
    final granted = await android?.requestNotificationsPermission();
    return granted ?? true;
  }

  static Future<bool> areNotificationsEnabled() async {
    final android = _plugin.resolvePlatformSpecificImplementation<
        AndroidFlutterLocalNotificationsPlugin>();
    final enabled = await android?.areNotificationsEnabled();
    return enabled ?? true;
  }

  /// The notification id is derived from the alert id, so a socket event and
  /// an FCM delivery for the same alert replace one tray entry instead of
  /// stacking two.
  static int idFor(String alertId) => alertId.hashCode & 0x7fffffff;

  static AndroidNotificationDetails _details({
    required String body,
    String? title,
  }) {
    return AndroidNotificationDetails(
      channelId,
      channelName,
      channelDescription: channelDescription,
      importance: Importance.max,
      priority: Priority.max,
      category: AndroidNotificationCategory.alarm,
      visibility: NotificationVisibility.public,
      playSound: true,
      enableVibration: true,
      ticker: title,
      color: const Color(0xFFDC2626),
      fullScreenIntent: true,
      autoCancel: true,
      audioAttributesUsage: AudioAttributesUsage.alarm,
      styleInformation: BigTextStyleInformation(body),
    );
  }

  static Future<void> showAlert({
    required String alertId,
    required String title,
    required String body,
  }) async {
    if (!_ready) return;
    await _plugin.show(
      idFor(alertId),
      title,
      body,
      NotificationDetails(android: _details(body: body, title: title)),
      payload: alertId,
    );
  }

  /// Removes the tray entry once the alert is acknowledged, resolved or
  /// dismissed in-app. Never called just because the sheet was closed.
  static Future<void> cancel(String alertId) async {
    if (!_ready) return;
    try {
      await _plugin.cancel(idFor(alertId));
    } on Object {
      // A tray cleanup failure must never affect the alert action itself.
    }
  }

  static Future<void> clear() async {
    if (!_ready) return;
    try {
      await _plugin.cancelAll();
    } on Object {
      // Best effort.
    }
  }

  /// Local-only notification used from Settings to prove the channel, sound
  /// and tray icon work without waiting for a real SOS.
  static Future<void> showTest() async {
    if (!_ready) return;
    await _plugin.show(
      99001,
      'Test alert',
      'If you can see and hear this, warden alerts will reach this phone.',
      NotificationDetails(
        android: _details(
          body:
              'If you can see and hear this, warden alerts will reach this phone.',
        ),
      ),
    );
  }
}
