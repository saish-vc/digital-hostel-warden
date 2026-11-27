import 'package:flutter/services.dart';

/// Audible cue for a new alert, deduped per alert id so the socket event and
/// the foreground FCM message cannot double-ring (same 5 s window as the web
/// dashboard).
class AlarmCue {
  const AlarmCue._();

  static const Duration _window = Duration(seconds: 5);
  static final Map<String, DateTime> _lastPlayed = {};

  static bool play(String alertId) {
    final now = DateTime.now();
    final last = _lastPlayed[alertId];
    if (last != null && now.difference(last) < _window) return false;
    _lastPlayed[alertId] = now;
    if (_lastPlayed.length > 50) {
      _lastPlayed.removeWhere(
        (_, time) => now.difference(time) > const Duration(minutes: 10),
      );
    }
    SystemSound.play(SystemSoundType.alert);
    HapticFeedback.heavyImpact();
    return true;
  }

  static void reset() => _lastPlayed.clear();
}
