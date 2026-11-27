import 'dart:async';

import 'package:flutter/foundation.dart';

import '../models/alert.dart';
import '../services/api.dart';
import '../services/beep.dart';
import '../services/notifications.dart';

enum AlertFilter { active, resolved, all }

/// Board state: the full alert list, the three counters, the unseen banner and
/// the acknowledge/resolve transitions. Every mutation is server-confirmed.
class AlertsController extends ChangeNotifier {
  AlertsController(this._api);

  final ApiClient _api;

  List<Alert> _alerts = const [];
  AlertFilter _filter = AlertFilter.active;
  bool _loading = false;
  String? _error;
  String? _actionId;
  DateTime? _lastUpdated;
  bool _firstLoad = true;
  final Set<String> _unseen = <String>{};
  final Set<String> _knownPending = <String>{};
  String? _justResolvedId;

  final ValueNotifier<String?> escalationFailure = ValueNotifier(null);

  List<Alert> get alerts => _alerts;
  AlertFilter get filter => _filter;
  bool get loading => _loading;
  String? get error => _error;
  String? get actionId => _actionId;
  DateTime? get lastUpdated => _lastUpdated;
  int get unseenCount => _unseen.length;
  String? get justResolvedId => _justResolvedId;

  List<Alert> get visibleAlerts {
    switch (_filter) {
      case AlertFilter.active:
        return _alerts.where((alert) => !alert.isResolved).toList(growable: false);
      case AlertFilter.resolved:
        return _alerts.where((alert) => alert.isResolved).toList(growable: false);
      case AlertFilter.all:
        return List<Alert>.unmodifiable(_alerts);
    }
  }

  int get pendingCount =>
      _alerts.where((alert) => alert.isPending).length;

  int get respondingCount =>
      _alerts.where((alert) => alert.isAcknowledged).length;

  int get resolvedTodayCount {
    final now = DateTime.now();
    return _alerts.where((alert) {
      final resolved = alert.resolvedAt;
      return alert.isResolved &&
          resolved != null &&
          resolved.year == now.year &&
          resolved.month == now.month &&
          resolved.day == now.day;
    }).length;
  }

  Alert? byId(String? id) {
    if (id == null) return null;
    for (final alert in _alerts) {
      if (alert.id == id) return alert;
    }
    return null;
  }

  void setFilter(AlertFilter filter) {
    if (_filter == filter) return;
    _filter = filter;
    if (filter == AlertFilter.active) _unseen.clear();
    notifyListeners();
  }

  void clearUnseen() {
    if (_unseen.isEmpty) return;
    _unseen.clear();
    notifyListeners();
  }

  Future<void> load({bool silent = false}) async {
    if (_loading) return;
    _loading = true;
    if (!silent) _error = null;
    notifyListeners();
    try {
      final rows = await _api.fetchAlerts();
      _alerts = rows;
      final pending = rows.where((alert) => alert.isPending).map((a) => a.id).toSet();
      if (!_firstLoad && _filter != AlertFilter.active) {
        _unseen.addAll(pending.difference(_knownPending));
      }
      _knownPending
        ..clear()
        ..addAll(pending);
      _firstLoad = false;
      _lastUpdated = DateTime.now();
      _error = null;
    } on ApiException catch (error) {
      _error = error.message;
    } finally {
      _loading = false;
      notifyListeners();
    }
  }

  Future<bool> acknowledge(String id) async {
    if (_actionId != null) return false;
    _actionId = id;
    _error = null;
    notifyListeners();
    try {
      final updated = await _api.acknowledgeAlert(id);
      _replace(updated);
      // The tray entry has served its purpose; the case is now in-app.
      unawaited(NotificationService.cancel(id));
      return true;
    } on ApiException catch (error) {
      _error = error.message;
      return false;
    } finally {
      _actionId = null;
      notifyListeners();
    }
  }

  Future<bool> resolve(String id, String note) async {
    if (_actionId != null) return false;
    _actionId = id;
    _error = null;
    notifyListeners();
    try {
      final updated = await _api.resolveAlert(id, note);
      _replace(updated);
      _justResolvedId = id;
      _unseen.remove(id);
      unawaited(NotificationService.cancel(id));
      return true;
    } on ApiException catch (error) {
      _error = error.message;
      return false;
    } finally {
      _actionId = null;
      notifyListeners();
    }
  }

  void clearJustResolved() {
    if (_justResolvedId == null) return;
    _justResolvedId = null;
    notifyListeners();
  }

  void handleSocketEvent(String event, Map<String, dynamic> payload) {
    switch (event) {
      case 'alert:new':
        final alert = Alert.fromJson(payload);
        if (byId(alert.id) == null) {
          _alerts = [alert, ..._alerts];
          if (alert.isPending) _knownPending.add(alert.id);
          if (_filter != AlertFilter.active) _unseen.add(alert.id);
          AlarmCue.play(alert.id);
          notifyListeners();
        }
        break;
      case 'alert:updated':
      case 'alert:resolved':
        final resolved = Alert.fromJson(payload);
        _replace(resolved);
        if (resolved.isResolved) {
          unawaited(NotificationService.cancel(resolved.id));
        }
        notifyListeners();
        break;
      case 'alert:escalated':
        final id = payload['alertId']?.toString();
        final sentAt = _parseDate(payload['sentAt']);
        if (id != null && sentAt != null) {
          _patchEscalated(id, sentAt);
          notifyListeners();
        }
        break;
      case 'alert:escalation_failed':
        final alert = byId(payload['alertId']?.toString());
        escalationFailure.value = alert == null
            ? 'SMS escalation failed. Check the on-call phone.'
            : 'SMS escalation failed for ${alert.student.name} · Room ${alert.student.roomNumber}.';
        break;
    }
  }

  void _replace(Alert updated) {
    final index = _alerts.indexWhere((alert) => alert.id == updated.id);
    if (index < 0) {
      _alerts = [updated, ..._alerts];
    } else {
      final next = List<Alert>.of(_alerts);
      next[index] = updated;
      _alerts = next;
    }
    if (updated.isResolved) {
      _unseen.remove(updated.id);
      _knownPending.remove(updated.id);
    }
  }

  void _patchEscalated(String id, DateTime sentAt) {
    final index = _alerts.indexWhere((alert) => alert.id == id);
    if (index < 0) return;
    final next = List<Alert>.of(_alerts);
    next[index] = next[index].copyWith(escalatedAt: sentAt);
    _alerts = next;
  }

  DateTime? _parseDate(dynamic value) {
    if (value is String && value.isNotEmpty) {
      return DateTime.tryParse(value)?.toLocal();
    }
    return null;
  }

  void reset() {
    _alerts = const [];
    _filter = AlertFilter.active;
    _error = null;
    _actionId = null;
    _lastUpdated = null;
    _firstLoad = true;
    _unseen.clear();
    _knownPending.clear();
    _justResolvedId = null;
    notifyListeners();
  }
}
