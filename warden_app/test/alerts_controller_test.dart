import 'package:flutter_test/flutter_test.dart';
import 'package:warden_app/models/alert.dart';
import 'package:warden_app/services/api.dart';
import 'package:warden_app/state/alerts_controller.dart';

Alert alert(
  String id, {
  String status = 'PENDING',
  DateTime? createdAt,
  DateTime? escalatedAt,
  String type = 'MEDICAL',
}) {
  return Alert(
    id: id,
    studentId: 's-$id',
    type: type,
    status: status,
    latitude: null,
    longitude: null,
    locationAccuracy: null,
    createdAt: createdAt ?? DateTime.now(),
    acknowledgedAt: null,
    acknowledgedBy: null,
    resolvedAt: null,
    resolutionNote: null,
    escalatedAt: escalatedAt,
    student: StudentInfo(
      id: 's-$id',
      name: 'Student $id',
      roomNumber: 'B-$id',
      emergencyContact: '+91 90000 00000',
      medicalConditions: null,
    ),
  );
}

class FakeApi extends ApiClient {
  FakeApi() : super(tokenProvider: () => null);

  List<Alert> rows = [];
  ApiException? acknowledgeError;
  ApiException? resolveError;

  @override
  Future<List<Alert>> fetchAlerts({String? status, int limit = 500}) async {
    return List<Alert>.of(rows);
  }

  @override
  Future<Alert> acknowledgeAlert(String id) async {
    if (acknowledgeError != null) throw acknowledgeError!;
    final current = rows.firstWhere((a) => a.id == id);
    final updated = current.copyWith(status: 'ACKNOWLEDGED');
    rows = [for (final a in rows) a.id == id ? updated : a];
    return updated;
  }

  @override
  Future<Alert> resolveAlert(String id, String note) async {
    if (resolveError != null) throw resolveError!;
    final current = rows.firstWhere((a) => a.id == id);
    final updated = current.copyWith(status: 'RESOLVED');
    rows = [for (final a in rows) a.id == id ? updated : a];
    return updated;
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late FakeApi api;
  late AlertsController controller;

  setUp(() {
    api = FakeApi();
    controller = AlertsController(api);
  });

  test('load fills the board and the three counters', () async {
    api.rows = [
      alert('1'),
      alert('2', status: 'ACKNOWLEDGED'),
      alert('3', status: 'RESOLVED'),
    ];
    await controller.load();

    expect(controller.alerts, hasLength(3));
    expect(controller.pendingCount, 1);
    expect(controller.respondingCount, 1);
    expect(controller.visibleAlerts.map((a) => a.id), ['1', '2']);
  });

  test('unseen banner counts only pending alerts that appear while filtered',
      () async {
    api.rows = [alert('1')];
    await controller.load();
    controller.setFilter(AlertFilter.resolved);

    api.rows = [alert('1'), alert('2')];
    await controller.load();

    expect(controller.unseenCount, 1);
    controller.setFilter(AlertFilter.active);
    expect(controller.unseenCount, 0);
  });

  test('acknowledge applies only the server response', () async {
    api.rows = [alert('1')];
    await controller.load();

    final ok = await controller.acknowledge('1');

    expect(ok, isTrue);
    expect(controller.byId('1')!.status, 'ACKNOWLEDGED');
    expect(controller.pendingCount, 0);
  });

  test('a 409 leaves the row pending and surfaces the server message',
      () async {
    api.rows = [alert('1')];
    await controller.load();
    api.acknowledgeError = ApiException(
      'Alert is already RESOLVED',
      statusCode: 409,
    );

    final ok = await controller.acknowledge('1');

    expect(ok, isFalse);
    expect(controller.byId('1')!.status, 'PENDING');
    expect(controller.error, 'Alert is already RESOLVED');
  });

  test('resolve replaces the row with the confirmed RESOLVED state', () async {
    api.rows = [alert('1', status: 'ACKNOWLEDGED')];
    await controller.load();

    final ok = await controller.resolve('1', 'Sent to clinic');

    expect(ok, isTrue);
    expect(controller.byId('1')!.status, 'RESOLVED');
    expect(controller.visibleAlerts, isEmpty);
  });

  test('alert:new prepends once and ignores a duplicate delivery', () async {
    await controller.load();
    controller.handleSocketEvent('alert:new', {
      'id': '1',
      'studentId': 's1',
      'type': 'FIRE',
      'status': 'PENDING',
      'createdAt': DateTime.now().toIso8601String(),
      'student': {'id': 's1', 'name': 'Aarav', 'roomNumber': 'B-204'},
    });
    controller.handleSocketEvent('alert:new', {
      'id': '1',
      'studentId': 's1',
      'type': 'FIRE',
      'status': 'PENDING',
      'createdAt': DateTime.now().toIso8601String(),
      'student': {'id': 's1', 'name': 'Aarav', 'roomNumber': 'B-204'},
    });

    expect(controller.alerts, hasLength(1));
    expect(controller.alerts.first.type, 'FIRE');
  });

  test('alert:escalated sets the pill timestamp from the server', () async {
    api.rows = [alert('1')];
    await controller.load();

    controller.handleSocketEvent('alert:escalated', {
      'alertId': '1',
      'sentAt': '2026-11-27T05:00:00.000Z',
      'outcome': 'sent',
    });

    expect(controller.byId('1')!.escalatedAt, isNotNull);
  });

  test('escalation_failed raises a failure message without clearing the pill',
      () async {
    api.rows = [
      alert('1', escalatedAt: DateTime.utc(2026, 11, 27, 5)),
    ];
    await controller.load();

    controller.handleSocketEvent('alert:escalation_failed', {
      'alertId': '1',
      'sentAt': '2026-11-27T05:01:00.000Z',
      'outcome': 'failed',
    });

    expect(controller.escalationFailure.value, contains('SMS escalation failed'));
    expect(controller.byId('1')!.escalatedAt, isNotNull);
  });
}
