double? _asDouble(dynamic value) {
  if (value is num) return value.toDouble();
  if (value is String) return double.tryParse(value);
  return null;
}

DateTime? _asDate(dynamic value) {
  if (value is String && value.isNotEmpty) {
    return DateTime.tryParse(value)?.toLocal();
  }
  return null;
}

String _asString(dynamic value) => value?.toString() ?? '';

Map<String, dynamic> _asMap(dynamic value) {
  if (value is Map<String, dynamic>) return value;
  if (value is Map) return value.cast<String, dynamic>();
  return const <String, dynamic>{};
}

class StudentInfo {
  const StudentInfo({
    required this.id,
    required this.name,
    required this.roomNumber,
    required this.emergencyContact,
    required this.medicalConditions,
  });

  final String id;
  final String name;
  final String roomNumber;
  final String emergencyContact;
  final String? medicalConditions;

  factory StudentInfo.fromJson(Map<String, dynamic> json) => StudentInfo(
        id: _asString(json['id']),
        name: _asString(json['name']),
        roomNumber: _asString(json['roomNumber']),
        emergencyContact: _asString(json['emergencyContact']),
        medicalConditions: (json['medicalConditions'] as String?)?.trim(),
      );

  String get contactDigits => emergencyContact.replaceAll(RegExp(r'[^0-9+]'), '');
}

/// Extra block attached only to an SOS raised from an approved leave.
class OffCampusLeave {
  const OffCampusLeave({
    required this.leaveId,
    required this.destination,
    required this.reason,
    required this.emergencyContact,
    required this.expectedReturn,
  });

  final String leaveId;
  final String destination;
  final String reason;
  final String emergencyContact;
  final DateTime? expectedReturn;

  factory OffCampusLeave.fromJson(Map<String, dynamic> json) => OffCampusLeave(
        leaveId: _asString(json['leaveId']),
        destination: _asString(json['destination']),
        reason: _asString(json['reason']),
        emergencyContact: _asString(json['emergencyContact']),
        expectedReturn: _asDate(json['expectedReturn']),
      );
}

class Alert {
  const Alert({
    required this.id,
    required this.studentId,
    required this.type,
    required this.status,
    required this.latitude,
    required this.longitude,
    required this.locationAccuracy,
    required this.createdAt,
    required this.acknowledgedAt,
    required this.acknowledgedBy,
    required this.resolvedAt,
    required this.resolutionNote,
    required this.escalatedAt,
    required this.student,
    this.offCampusLeave,
  });

  final String id;
  final String studentId;
  final String type;
  final String status;
  final double? latitude;
  final double? longitude;
  final double? locationAccuracy;
  final DateTime createdAt;
  final DateTime? acknowledgedAt;
  final String? acknowledgedBy;
  final DateTime? resolvedAt;
  final String? resolutionNote;
  final DateTime? escalatedAt;
  final StudentInfo student;
  final OffCampusLeave? offCampusLeave;

  bool get isPending => status == 'PENDING';
  bool get isAcknowledged => status == 'ACKNOWLEDGED';
  bool get isResolved => status == 'RESOLVED';
  bool get isActive => !isResolved;
  bool get hasLocation => latitude != null && longitude != null;

  factory Alert.fromJson(Map<String, dynamic> json) => Alert(
        id: _asString(json['id']),
        studentId: _asString(json['studentId']),
        type: _asString(json['type']),
        status: _asString(json['status']),
        latitude: _asDouble(json['latitude']),
        longitude: _asDouble(json['longitude']),
        locationAccuracy: _asDouble(json['locationAccuracy']),
        createdAt: _asDate(json['createdAt']) ?? DateTime.now(),
        acknowledgedAt: _asDate(json['acknowledgedAt']),
        acknowledgedBy: json['acknowledgedBy'] as String?,
        resolvedAt: _asDate(json['resolvedAt']),
        resolutionNote: (json['resolutionNote'] as String?)?.trim(),
        escalatedAt: _asDate(json['escalatedAt']),
        student: StudentInfo.fromJson(_asMap(json['student'])),
        offCampusLeave: json['offCampusLeave'] is Map
            ? OffCampusLeave.fromJson(_asMap(json['offCampusLeave']))
            : null,
      );

  Alert copyWith({DateTime? escalatedAt, String? status}) => Alert(
        id: id,
        studentId: studentId,
        type: type,
        status: status ?? this.status,
        latitude: latitude,
        longitude: longitude,
        locationAccuracy: locationAccuracy,
        createdAt: createdAt,
        acknowledgedAt: acknowledgedAt,
        acknowledgedBy: acknowledgedBy,
        resolvedAt: resolvedAt,
        resolutionNote: resolutionNote,
        escalatedAt: escalatedAt ?? this.escalatedAt,
        student: student,
        offCampusLeave: offCampusLeave,
      );
}
