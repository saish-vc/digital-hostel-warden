import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

/// Native Android helpers that need the Activity: the on-duty foreground
/// service (keeps the socket alive while the app is not in front) and
/// FLAG_SECURE (hides student medical data in the recents thumbnail).
///
/// Every call is best-effort: a platform failure must never break the board.
class DeviceService {
  const DeviceService._();

  static const MethodChannel _channel = MethodChannel('hostelguard/device');

  static Future<void> setOnDuty(bool enabled) async {
    try {
      await _channel.invokeMethod<void>(
        enabled ? 'startOnDuty' : 'stopOnDuty',
      );
    } on PlatformException catch (error) {
      debugPrint('[device] on-duty service unavailable: ${error.message}');
    } on MissingPluginException {
      // Non-Android host (widget tests, desktop).
    }
  }

  static Future<void> setSecure(bool enabled) async {
    try {
      await _channel.invokeMethod<void>('setSecure', {'enabled': enabled});
    } on PlatformException catch (error) {
      debugPrint('[device] could not set FLAG_SECURE: ${error.message}');
    } on MissingPluginException {
      // Non-Android host.
    }
  }

  /// `true` means Android may freeze the app (battery optimisation is on).
  /// `null` when the platform cannot answer, so the UI says "unknown" rather
  /// than claiming the phone is healthy.
  static Future<bool?> isBatteryOptimized() async {
    try {
      return await _channel.invokeMethod<bool>('isBatteryOptimized');
    } on PlatformException catch (error) {
      debugPrint('[device] battery status unavailable: ${error.message}');
      return null;
    } on MissingPluginException {
      return null;
    }
  }

  static Future<void> requestBatteryExemption() async {
    try {
      await _channel.invokeMethod<void>('requestBatteryExemption');
    } on PlatformException catch (error) {
      debugPrint('[device] battery request failed: ${error.message}');
    } on MissingPluginException {
      // Non-Android host.
    }
  }
}
