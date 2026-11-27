import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:url_launcher/url_launcher.dart';

import 'device_service.dart';

/// Delivery-health checks that Android exposes outside the app, plus the
/// deep links needed to fix each one. The UI must never claim an alert will
/// ring when one of these is degraded.
class Reliability {
  const Reliability._();

  /// `true` = battery optimisation is ON (the app can be frozen), `false` =
  /// exempt, `null` = not checked yet.
  static final ValueNotifier<bool?> batteryOptimized = ValueNotifier(null);

  static Future<void> refreshBattery() async {
    batteryOptimized.value = await DeviceService.isBatteryOptimized();
  }

  static Future<void> requestBatteryExemption() async {
    await DeviceService.requestBatteryExemption();
    await refreshBattery();
  }

  static const _package = 'com.hostelguard.warden';

  static Future<void> openAppNotificationSettings() => _open(
        'intent:#Intent;action=android.settings.APP_NOTIFICATION_SETTINGS;'
        'S.android.provider.extra.APP_PACKAGE=$_package;end',
      );

  static Future<void> openChannelSettings() => _open(
        'intent:#Intent;action=android.settings.CHANNEL_NOTIFICATION_SETTINGS;'
        'S.android.provider.extra.APP_PACKAGE=$_package;'
        'S.android.provider.extra.CHANNEL_ID=warden_alerts;end',
      );

  static Future<void> openDndAccess() => _open(
        'intent:#Intent;action=android.settings.NOTIFICATION_POLICY_ACCESS_SETTINGS;end',
      );

  static Future<void> openFullScreenIntentSettings() => _open(
        'intent:#Intent;action=android.settings.MANAGE_APP_USE_FULL_SCREEN_INTENT;'
        'S.android.provider.extra.APP_PACKAGE=$_package;end',
      );

  static Future<void> openBatterySettings() => _open(
        'intent:#Intent;action=android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS;end',
      );

  static Future<void> _open(String intentUri) async {
    try {
      await launchUrl(
        Uri.parse(intentUri),
        mode: LaunchMode.externalApplication,
      );
    } on Object catch (error) {
      debugPrint('[reliability] could not open settings: $error');
    }
  }
}

/// Small typed wrapper over the two persisted reliability toggles. Both are
/// user choices, not alert state, so they live in SharedPreferences.
class DevicePrefs {
  const DevicePrefs._();

  static const _onDutyKey = 'on_duty';
  static const _secureKey = 'secure_screen';

  static Future<bool> onDuty() async =>
      (await SharedPreferences.getInstance()).getBool(_onDutyKey) ?? false;

  static Future<bool> secureScreen() async =>
      (await SharedPreferences.getInstance()).getBool(_secureKey) ?? false;

  static Future<void> setOnDuty(bool value) async =>
      (await SharedPreferences.getInstance()).setBool(_onDutyKey, value);

  static Future<void> setSecureScreen(bool value) async =>
      (await SharedPreferences.getInstance()).setBool(_secureKey, value);
}
