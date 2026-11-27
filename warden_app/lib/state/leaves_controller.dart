import 'package:flutter/foundation.dart';

import '../models/leave.dart';
import '../models/paging.dart';
import '../services/api.dart';

enum LeaveHistoryFilter { all, rejected, cancelled, returned }

enum GateOutcomeKind { departed, returned, notFound, error }

class GateOutcome {
  const GateOutcome({required this.kind, this.leave, this.message});

  final GateOutcomeKind kind;
  final Leave? leave;
  final String? message;

  bool get isSuccess =>
      kind == GateOutcomeKind.departed || kind == GateOutcomeKind.returned;
}

/// Leave desk state: four operational lists, the counters, the review and gate
/// transitions, and the "new request" banner.
class LeavesController extends ChangeNotifier {
  LeavesController(this._api);

  final ApiClient _api;

  LeaveStats _stats = LeaveStats.empty;
  List<Leave> _pending = const [];
  List<Leave> _approved = const [];
  List<Leave> _away = const [];
  List<Leave> _overdue = const [];
  List<Leave> _history = const [];
  LeaveHistoryFilter _historyFilter = LeaveHistoryFilter.all;
  bool _loading = false;
  bool _hasNewRequests = false;
  String? _error;
  String? _busyId;
  DateTime? _lastUpdated;

  LeaveStats get stats => _stats;
  List<Leave> get pending => _pending;
  List<Leave> get approved => _approved;
  List<Leave> get away => _away;
  List<Leave> get overdue => _overdue;
  bool get loading => _loading;
  bool get hasNewRequests => _hasNewRequests;
  String? get error => _error;
  String? get busyId => _busyId;
  DateTime? get lastUpdated => _lastUpdated;
  LeaveHistoryFilter get historyFilter => _historyFilter;

  List<Leave> get history {
    switch (_historyFilter) {
      case LeaveHistoryFilter.all:
        return _history;
      case LeaveHistoryFilter.rejected:
        return _history.where((leave) => leave.status == 'REJECTED').toList(growable: false);
      case LeaveHistoryFilter.cancelled:
        return _history.where((leave) => leave.status == 'CANCELLED').toList(growable: false);
      case LeaveHistoryFilter.returned:
        return _history.where((leave) => leave.status == 'RETURNED').toList(growable: false);
    }
  }

  void setHistoryFilter(LeaveHistoryFilter filter) {
    if (_historyFilter == filter) return;
    _historyFilter = filter;
    notifyListeners();
  }

  void markRequestsSeen() {
    if (!_hasNewRequests) return;
    _hasNewRequests = false;
    notifyListeners();
  }

  Future<void> loadAll({bool silent = false}) async {
    if (_loading) return;
    _loading = true;
    if (!silent) _error = null;
    notifyListeners();
    try {
      final results = await Future.wait<Object?>([
        _api.fetchLeaveStats(),
        _api.fetchLeaves(limit: 100),
        _api.fetchActiveLeaves(),
        _api.fetchOverdueLeaves(),
      ]);
      _stats = results[0] as LeaveStats;
      final page = results[1] as ApiPage<Leave>;
      final rows = page.data;
      final active = (results[2] as List).cast<Leave>();
      final overdue = (results[3] as List).cast<Leave>();

      _pending = rows.where((leave) => leave.status == 'SUBMITTED').toList(growable: false);
      _approved = rows.where((leave) => leave.status == 'APPROVED').toList(growable: false);
      _history = rows
          .where((leave) =>
              leave.status == 'RETURNED' ||
              leave.status == 'REJECTED' ||
              leave.status == 'CANCELLED')
          .toList(growable: false);

      final overdueIds = overdue.map((leave) => leave.id).toSet();
      _overdue = overdue;
      _away = active.where((leave) => !overdueIds.contains(leave.id)).toList(growable: false);
      _lastUpdated = DateTime.now();
      _error = null;
      if (_pending.isEmpty) _hasNewRequests = false;
    } on ApiException catch (error) {
      _error = error.message;
    } finally {
      _loading = false;
      notifyListeners();
    }
  }

  Future<bool> review(
    String id,
    String decision, {
    String? remarks,
  }) async {
    if (_busyId != null) return false;
    _busyId = id;
    _error = null;
    notifyListeners();
    try {
      await _api.reviewLeave(id, decision, remarks: remarks);
      await loadAll(silent: true);
      return true;
    } on ApiException catch (error) {
      _error = error.message;
      return false;
    } finally {
      _busyId = null;
      notifyListeners();
    }
  }

  Future<bool> gateDeparture(String id, String code) async {
    if (_busyId != null) return false;
    _busyId = id;
    _error = null;
    notifyListeners();
    try {
      await _api.gateDeparture(id, code);
      await loadAll(silent: true);
      return true;
    } on ApiException catch (error) {
      _error = error.message;
      return false;
    } finally {
      _busyId = null;
      notifyListeners();
    }
  }

  Future<bool> gateReturn(String id) async {
    if (_busyId != null) return false;
    _busyId = id;
    _error = null;
    notifyListeners();
    try {
      await _api.gateReturn(id);
      await loadAll(silent: true);
      return true;
    } on ApiException catch (error) {
      _error = error.message;
      return false;
    } finally {
      _busyId = null;
      notifyListeners();
    }
  }

  Leave? byId(String id) {
    for (final leave in [
      ..._pending,
      ..._approved,
      ..._away,
      ..._overdue,
      ..._history,
    ]) {
      if (leave.id == id) return leave;
    }
    return null;
  }

  /// One gate action for both directions, keyed by the pass code the guard
  /// reads out (the same flow as the web dashboard's "Gate check").
  Future<GateOutcome> gateCheck(String rawCode) async {
    final code = rawCode.trim().toUpperCase();
    if (code.isEmpty) {
      return const GateOutcome(
        kind: GateOutcomeKind.error,
        message: 'Enter the gate pass code (HG-XXXXXX).',
      );
    }
    if (_busyId != null) {
      return const GateOutcome(
        kind: GateOutcomeKind.error,
        message: 'Another leave action is still running.',
      );
    }

    _busyId = 'gate';
    _error = null;
    notifyListeners();
    try {
      Leave? match(Iterable<Leave> rows) {
        for (final leave in rows) {
          if ((leave.gatePassCode ?? '').toUpperCase() == code) return leave;
        }
        return null;
      }

      var departing = match(_approved);
      var returning = match([..._away, ..._overdue]);
      if (departing == null && returning == null) {
        await loadAll(silent: true);
        departing = match(_approved);
        returning = match([..._away, ..._overdue]);
      }

      if (departing != null) {
        final updated = await _api.gateDeparture(departing.id, code);
        await loadAll(silent: true);
        return GateOutcome(kind: GateOutcomeKind.departed, leave: updated);
      }
      if (returning != null) {
        final updated = await _api.gateReturn(returning.id);
        await loadAll(silent: true);
        return GateOutcome(kind: GateOutcomeKind.returned, leave: updated);
      }
      return GateOutcome(
        kind: GateOutcomeKind.notFound,
        message: 'No approved or away leave matches $code.',
      );
    } on ApiException catch (error) {
      _error = error.message;
      return GateOutcome(kind: GateOutcomeKind.error, message: error.message);
    } finally {
      _busyId = null;
      notifyListeners();
    }
  }

  void handleSocketEvent(String event, Map<String, dynamic> payload) {
    if (event == 'leave:created') {
      _hasNewRequests = true;
      notifyListeners();
    }
    // Every leave event can change more than one list (counters, gate state),
    // so refetch rather than patching payloads.
    loadAll(silent: true);
  }

  void reset() {
    _stats = LeaveStats.empty;
    _pending = const [];
    _approved = const [];
    _away = const [];
    _overdue = const [];
    _history = const [];
    _historyFilter = LeaveHistoryFilter.all;
    _error = null;
    _busyId = null;
    _hasNewRequests = false;
    _lastUpdated = null;
    notifyListeners();
  }
}
