import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';

import 'notifications.dart';

enum PushPermissionState { unknown, granted, denied, unsupported }

/// Runs in a separate isolate when a message arrives while the app is
/// backgrounded or killed. Notification-payload messages have already been
/// posted to the tray by Android, so this only adds a tray entry for a
/// data-only message (defence in depth, not the primary path).
///
/// Every failure is swallowed: a crash here would be invisible to the warden
/// and the socket/SMS paths must keep working.
@pragma('vm:entry-point')
Future<void> firebaseBackgroundHandler(RemoteMessage message) async {
  try {
    await Firebase.initializeApp();
  } catch (error) {
    debugPrint('[push] background Firebase init failed: $error');
    return;
  }
  try {
    await NotificationService.initBackground();
  } catch (error) {
    debugPrint('[push] background notification init failed: $error');
    return;
  }

  final alertId = message.data['alertId']?.toString() ?? '';
  if (alertId.isEmpty) return;
  // Android already rendered the notification block — do not post a duplicate.
  if (message.notification != null) return;

  final type = message.data['type']?.toString();
  await NotificationService.showAlert(
    alertId: alertId,
    title: 'Emergency alert',
    body: type == null || type.isEmpty
        ? 'Open HostelGuard Warden for details.'
        : '$type · open the app for details.',
  );
}

/// Thin wrapper over FCM: permission, token, foreground presentation and tap
/// routing. Registration with the backend happens in AppState, because it
/// needs the current JWT.
class PushService {
  PushService._();

  static final PushService instance = PushService._();

  final ValueNotifier<PushPermissionState> permission =
      ValueNotifier(PushPermissionState.unknown);
  final ValueNotifier<String?> deviceToken = ValueNotifier(null);

  /// Set when a notification is tapped (cold start or background).
  final ValueNotifier<String?> openAlertId = ValueNotifier(null);

  /// Set when a message arrives while the app is in the foreground.
  final ValueNotifier<String?> foregroundAlertId = ValueNotifier(null);

  bool _started = false;

  Future<void> start() async {
    if (_started) return;
    _started = true;
    try {
      final messaging = FirebaseMessaging.instance;
      await messaging.setAutoInitEnabled(true);

      final settings = await messaging.requestPermission(
        alert: true,
        badge: true,
        sound: true,
      );
      permission.value = switch (settings.authorizationStatus) {
        AuthorizationStatus.authorized => PushPermissionState.granted,
        AuthorizationStatus.provisional => PushPermissionState.granted,
        AuthorizationStatus.denied => PushPermissionState.denied,
        AuthorizationStatus.deniedPermanently => PushPermissionState.denied,
        AuthorizationStatus.notDetermined => PushPermissionState.unknown,
      };

      // Android 13+ gates the tray itself behind POST_NOTIFICATIONS; the FCM
      // status above does not cover it.
      final notificationsAllowed = await NotificationService.requestPermission();
      if (!notificationsAllowed) {
        permission.value = PushPermissionState.denied;
      }

      // The backend stores and multicasts FCM registration tokens, so keep
      // getToken/onTokenRefresh until the Admin SDK moves to installation IDs.
      // ignore: deprecated_member_use
      final token = await messaging.getToken();
      if (token != null && token.isNotEmpty) deviceToken.value = token;
      // ignore: deprecated_member_use
      messaging.onTokenRefresh.listen((value) {
        if (value.isNotEmpty) deviceToken.value = value;
      });

      FirebaseMessaging.onMessage.listen(_handleForeground);
      FirebaseMessaging.onMessageOpenedApp.listen((message) {
        final id = message.data['alertId'];
        if (id != null && id.isNotEmpty) openAlertId.value = id;
      });

      final initial = await messaging.getInitialMessage();
      if (initial != null) {
        final id = initial.data['alertId'];
        if (id != null && id.isNotEmpty) openAlertId.value = id;
      }
    } catch (error) {
      permission.value = PushPermissionState.unsupported;
      debugPrint('[push] initialization failed: $error');
    }
  }

  void _handleForeground(RemoteMessage message) {
    final id = message.data['alertId'];
    if (id == null || id.isEmpty) return;
    final title = message.notification?.title ?? 'Emergency alert';
    final body = message.notification?.body ?? _fallbackBody(message);
    // Same deterministic id as a background delivery, so the foreground local
    // copy replaces rather than duplicates the tray entry.
    NotificationService.showAlert(alertId: id, title: title, body: body);
    foregroundAlertId.value = id;
  }

  String _fallbackBody(RemoteMessage message) {
    final type = message.data['type'];
    return type == null || type.isEmpty ? 'Open the app for details' : '$type';
  }

  Future<void> refreshPermission() async {
    final enabled = await NotificationService.areNotificationsEnabled();
    if (!enabled) {
      permission.value = PushPermissionState.denied;
    } else if (permission.value == PushPermissionState.denied) {
      permission.value = PushPermissionState.granted;
    }
  }
}
