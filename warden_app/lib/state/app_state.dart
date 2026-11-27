import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';

import '../config.dart';
import '../services/api.dart';
import '../services/beep.dart';
import '../services/device_service.dart';
import '../services/notifications.dart';
import '../services/push.dart';
import '../services/reliability.dart';
import '../services/session_store.dart';
import '../services/socket.dart';
import 'alerts_controller.dart';
import 'leaves_controller.dart';

enum SessionPhase { restoring, loggedOut, loggedIn }

/// Composition root: owns the session, the two controllers and the wiring
/// between HTTP, socket and push.
class AppState extends ChangeNotifier {
  AppState();

  final SessionStore _store = SessionStore();

  late final ApiClient api;
  late final AlertsController alerts;
  late final LeavesController leaves;

  SessionPhase _phase = SessionPhase.restoring;
  String? _token;
  SessionUser? _user;
  String? _loginError;
  String? _notice;
  String? _registeredToken;
  bool _pushRegistered = false;
  bool _loggingOut = false;

  /// Set by the widget root so a 401 can drop any pushed routes.
  void Function()? onSessionEnded;

  final ValueNotifier<String?> pendingOpenAlert = ValueNotifier(null);

  /// A foreground alert that should raise the full-screen alarm.
  final ValueNotifier<String?> alarmAlertId = ValueNotifier(null);

  SessionPhase get phase => _phase;
  String? get token => _token;
  SessionUser? get user => _user;
  String? get loginError => _loginError;
  String? get notice => _notice;
  bool get isLoggedIn => _phase == SessionPhase.loggedIn;
  bool get pushRegistered => _pushRegistered;

  Future<void> init() async {
    api = ApiClient(
      tokenProvider: () => _token,
      onUnauthorized: _handleUnauthorized,
    );
    alerts = AlertsController(api);
    leaves = LeavesController(api);

    PushService.instance.deviceToken.addListener(_syncPushToken);
    PushService.instance.openAlertId.addListener(_onOpenAlert);
    PushService.instance.foregroundAlertId.addListener(_onForegroundAlert);

    final stored = await _store.read();
    if (stored != null) {
      _token = stored.token;
      _user = stored.user;
      _phase = SessionPhase.loggedIn;
      _startSession();
    } else {
      _phase = SessionPhase.loggedOut;
    }
    await _applyDevicePreferences(sessionActive: isLoggedIn);
    notifyListeners();
  }

  /// Applies the persisted on-duty and screen-security choices. Called at
  /// startup and after login so a service left running from a previous
  /// process is stopped when the user is signed out.
  Future<void> _applyDevicePreferences({required bool sessionActive}) async {
    try {
      final secure = await DevicePrefs.secureScreen();
      await DeviceService.setSecure(secure);
      final onDuty = await DevicePrefs.onDuty();
      await DeviceService.setOnDuty(sessionActive && onDuty);
    } catch (error) {
      debugPrint('[device] preferences unavailable: $error');
    }
  }

  Future<bool> login(String email, String password) async {
    _loginError = null;
    notifyListeners();
    try {
      final result = await api.login(email, password);
      await _store.save(result.token, result.user);
      _token = result.token;
      _user = result.user;
      _phase = SessionPhase.loggedIn;
      _notice = null;
      _startSession();
      notifyListeners();
      return true;
    } on ApiException catch (error) {
      _loginError = error.retryAfterSeconds != null && error.isRateLimited
          ? 'Too many attempts. Try again in ${(error.retryAfterSeconds! / 60).ceil()} min.'
          : error.message;
      notifyListeners();
      return false;
    }
  }

  void _startSession() {
    final token = _token;
    if (token == null) return;
    SocketService.instance.connect(
      token,
      onEvent: _onSocketEvent,
      onConnected: _onSocketConnected,
      onUnauthorized: _handleUnauthorized,
    );
    _syncPushToken();
    unawaited(PushService.instance.start());
    unawaited(alerts.load());
    unawaited(leaves.loadAll());
    unawaited(_applyDevicePreferences(sessionActive: true));
  }

  void _onSocketEvent(String event, Map<String, dynamic> payload) {
    if (event.startsWith('alert:')) {
      alerts.handleSocketEvent(event, payload);
    } else if (event.startsWith('leave:')) {
      leaves.handleSocketEvent(event, payload);
    }
  }

  void _onSocketConnected() {
    // The web dashboard does not refetch after a reconnect; this closes the
    // gap between missed events and the visible board.
    unawaited(alerts.load(silent: true));
    unawaited(leaves.loadAll(silent: true));
    unawaited(PushService.instance.refreshPermission());
  }

  void _onOpenAlert() {
    final id = PushService.instance.openAlertId.value;
    if (id != null && id.isNotEmpty) {
      pendingOpenAlert.value = id;
      PushService.instance.openAlertId.value = null;
    }
  }

  void _onForegroundAlert() {
    final id = PushService.instance.foregroundAlertId.value;
    if (id == null || id.isEmpty) return;
    PushService.instance.foregroundAlertId.value = null;
    AlarmCue.play(id);
    if (alerts.byId(id)?.isResolved ?? false) return;
    alarmAlertId.value = id;
    unawaited(alerts.load(silent: true));
    unawaited(leaves.loadAll(silent: true));
  }

  void _syncPushToken() {
    final token = PushService.instance.deviceToken.value;
    if (token == null || token.isEmpty) return;
    if (!isLoggedIn || _token == null) return;
    if (token == _registeredToken) return;
    _registeredToken = token;
    unawaited(_registerPushToken(token));
  }

  Future<void> _registerPushToken(String token) async {
    try {
      await api.registerDeviceToken(token, _userAgent());
      if (_registeredToken != token) return;
      _pushRegistered = true;
      notifyListeners();
    } catch (error) {
      if (_registeredToken == token) _registeredToken = null;
      _pushRegistered = false;
      debugPrint('[push] token registration failed: $error');
    }
  }

  String _userAgent() {
    final os = Platform.operatingSystemVersion.replaceAll(RegExp(r'\s+'), ' ');
    return '${AppConfig.appName}/${AppConfig.version} (Android; $os)';
  }

  Future<void> reloadAll() async {
    await Future.wait<Object?>([
      alerts.load(silent: true),
      leaves.loadAll(silent: true),
    ]);
  }

  void _handleUnauthorized() {
    if (_loggingOut) return;
    unawaited(logout(notice: 'Session expired. Sign in again.'));
  }

  Future<void> logout({String? notice}) async {
    if (_loggingOut) return;
    _loggingOut = true;
    final pushToken = PushService.instance.deviceToken.value;
    if (pushToken != null && pushToken.isNotEmpty) {
      try {
        await api.unregisterDeviceToken(pushToken);
      } on ApiException {
        // Best effort: the token is also removed server-side when FCM reports
        // it as unregistered.
      }
    }
    _registeredToken = null;
    _pushRegistered = false;
    SocketService.instance.disconnect();
    await DeviceService.setOnDuty(false);
    await _store.clear();
    _token = null;
    _user = null;
    _phase = SessionPhase.loggedOut;
    _notice = notice;
    alerts.reset();
    leaves.reset();
    AlarmCue.reset();
    pendingOpenAlert.value = null;
    alarmAlertId.value = null;
    await NotificationService.clear();
    _loggingOut = false;
    onSessionEnded?.call();
    notifyListeners();
  }

  String? consumeNotice() {
    final value = _notice;
    _notice = null;
    return value;
  }

  void clearLoginError() {
    if (_loginError == null) return;
    _loginError = null;
    notifyListeners();
  }
}
