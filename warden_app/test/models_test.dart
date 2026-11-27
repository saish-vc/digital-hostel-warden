import 'package:flutter_test/flutter_test.dart';
import 'package:warden_app/models/alert.dart';
import 'package:warden_app/models/leave.dart';

Map<String, dynamic> alertJson({
  String type = 'MEDICAL',
  String status = 'PENDING',
  Map<String, dynamic>? student,
}) {
  return {
    'id': 'a1',
    'studentId': 's1',
    'organizationId': 'org-1',
    'type': type,
    'status': status,
    'latitude': 12.34,
    'longitude': null,
    'locationAccuracy': 8,
    'createdAt': '2026-11-27T04:30:00.000Z',
    'acknowledgedAt': null,
    'acknowledgedBy': null,
    'resolvedAt': null,
    'resolutionNote': null,
    'escalatedAt': null,
    'student': student ??
        {
          'id': 's1',
          'name': 'Aarav',
          'roomNumber': 'B-204',
          'emergencyContact': '+91 90000 00000',
          'medicalConditions': 'Asthma',
        },
    // A field the client does not know about must be ignored, not fatal.
    'serverOnlyField': {'nested': true},
  };
}

void main() {
  test('Alert parses the warden API shape', () {
    final alert = Alert.fromJson(alertJson());
    expect(alert.id, 'a1');
    expect(alert.type, 'MEDICAL');
    expect(alert.isPending, isTrue);
    expect(alert.student.name, 'Aarav');
    expect(alert.student.roomNumber, 'B-204');
    expect(alert.student.contactDigits, '+919000000000');
    expect(alert.hasLocation, isFalse);
    expect(alert.latitude, 12.34);
    expect(alert.createdAt.isUtc, isFalse); // converted for display
  });

  test('Alert tolerates missing optional fields and unknown types', () {
    final alert = Alert.fromJson({
      'id': 'a2',
      'type': 'SOMETHING_NEW',
      'status': 'PENDING',
      'createdAt': '2026-11-27T04:30:00.000Z',
      'student': {'id': 's2', 'name': 'Meera'},
    });
    expect(alert.type, 'SOMETHING_NEW');
    expect(alert.student.roomNumber, '');
    expect(alert.student.medicalConditions, isNull);
    expect(alert.locationAccuracy, isNull);
    expect(alert.offCampusLeave, isNull);
  });

  test('OFF_CAMPUS_LEAVE alerts carry the extra leave block', () {
    final json = alertJson(type: 'OFF_CAMPUS_LEAVE:MEDICAL');
    json['offCampusLeave'] = {
      'leaveId': 'l1',
      'destination': 'City Hospital',
      'reason': 'Fever',
      'emergencyContact': '+91 90000 00001',
      'expectedReturn': '2026-11-27T15:00:00.000Z',
    };
    final alert = Alert.fromJson(json);
    expect(alert.offCampusLeave, isNotNull);
    expect(alert.offCampusLeave!.leaveId, 'l1');
    expect(alert.offCampusLeave!.destination, 'City Hospital');
    expect(alert.offCampusLeave!.expectedReturn, isNotNull);
  });

  test('Leave parses the warden review shape and unknown status', () {
    final leave = Leave.fromJson({
      'id': 'l1',
      'studentId': 's1',
      'type': 'NIGHT_OUT',
      'reason': 'Family visit',
      'destination': 'Home',
      'emergencyContact': '+91 90000 00000',
      'departureTime': '2026-11-27T10:00:00.000Z',
      'expectedReturn': '2026-11-28T10:00:00.000Z',
      'status': 'SUBMITTED',
      'parentConsent': true,
      'createdAt': '2026-11-26T10:00:00.000Z',
      'updatedAt': '2026-11-26T10:00:00.000Z',
      'student': {'id': 's1', 'name': 'Aarav', 'roomNumber': 'B-204'},
      'reviewer': null,
    });
    expect(leave.status, 'SUBMITTED');
    expect(leave.type, 'NIGHT_OUT');
    expect(leave.parentConsent, isTrue);
    expect(leave.reviewerName, isNull);
  });
}
