import 'paging.dart';

class HistoryRow {
  const HistoryRow({
    required this.id,
    required this.type,
    required this.status,
    required this.createdAt,
    required this.acknowledgedAt,
    required this.resolvedAt,
    required this.resolutionNote,
    required this.acknowledgedByName,
    required this.studentName,
    required this.roomNumber,
  });

  final String id;
  final String type;
  final String status;
  final DateTime? createdAt;
  final DateTime? acknowledgedAt;
  final DateTime? resolvedAt;
  final String? resolutionNote;
  final String? acknowledgedByName;
  final String studentName;
  final String roomNumber;

  factory HistoryRow.fromJson(Map<String, dynamic> json) {
    final student = json['student'] is Map
        ? (json['student'] as Map).cast<String, dynamic>()
        : const <String, dynamic>{};
    return HistoryRow(
      id: json['id']?.toString() ?? '',
      type: json['type']?.toString() ?? '',
      status: json['status']?.toString() ?? '',
      createdAt: _date(json['createdAt']),
      acknowledgedAt: _date(json['acknowledgedAt']),
      resolvedAt: _date(json['resolvedAt']),
      resolutionNote: (json['resolutionNote'] as String?)?.trim(),
      acknowledgedByName: (json['acknowledgedByName'] as String?)?.trim(),
      studentName: student['name']?.toString() ?? '',
      roomNumber: student['roomNumber']?.toString() ?? '',
    );
  }

  static DateTime? _date(dynamic value) {
    if (value is String && value.isNotEmpty) {
      return DateTime.tryParse(value)?.toLocal();
    }
    return null;
  }
}

typedef HistoryPage = ApiPage<HistoryRow>;
