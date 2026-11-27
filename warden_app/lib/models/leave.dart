import 'alert.dart';

class Leave {
  const Leave({
    required this.id,
    required this.studentId,
    required this.type,
    required this.reason,
    required this.destination,
    required this.emergencyContact,
    required this.departureTime,
    required this.expectedReturn,
    required this.actualDeparture,
    required this.actualReturn,
    required this.status,
    required this.parentConsent,
    required this.gatePassCode,
    required this.reviewedAt,
    required this.reviewRemarks,
    required this.createdAt,
    required this.student,
    required this.reviewerName,
  });

  final String id;
  final String studentId;
  final String type;
  final String reason;
  final String destination;
  final String emergencyContact;
  final DateTime? departureTime;
  final DateTime? expectedReturn;
  final DateTime? actualDeparture;
  final DateTime? actualReturn;
  final String status;
  final bool parentConsent;
  final String? gatePassCode;
  final DateTime? reviewedAt;
  final String? reviewRemarks;
  final DateTime? createdAt;
  final StudentInfo student;
  final String? reviewerName;

  bool get isSubmitted => status == 'SUBMITTED';
  bool get isApproved => status == 'APPROVED';
  bool get isDeparted => status == 'DEPARTED';
  bool get isOverdue => status == 'OVERDUE';
  bool get isAway => status == 'DEPARTED' || status == 'OVERDUE';

  factory Leave.fromJson(Map<String, dynamic> json) {
    final reviewer = json['reviewer'];
    String? reviewerName;
    if (reviewer is Map) {
      final name = reviewer['name'];
      if (name is String && name.isNotEmpty) reviewerName = name;
    }
    return Leave(
      id: json['id']?.toString() ?? '',
      studentId: json['studentId']?.toString() ?? '',
      type: json['type']?.toString() ?? '',
      reason: json['reason']?.toString() ?? '',
      destination: json['destination']?.toString() ?? '',
      emergencyContact: json['emergencyContact']?.toString() ?? '',
      departureTime: _date(json['departureTime']),
      expectedReturn: _date(json['expectedReturn']),
      actualDeparture: _date(json['actualDeparture']),
      actualReturn: _date(json['actualReturn']),
      status: json['status']?.toString() ?? '',
      parentConsent: json['parentConsent'] == true,
      gatePassCode: (json['gatePassCode'] as String?)?.trim(),
      reviewedAt: _date(json['reviewedAt']),
      reviewRemarks: (json['reviewRemarks'] as String?)?.trim(),
      createdAt: _date(json['createdAt']),
      student: StudentInfo.fromJson(
        json['student'] is Map
            ? (json['student'] as Map).cast<String, dynamic>()
            : const {},
      ),
      reviewerName: reviewerName,
    );
  }

  static DateTime? _date(dynamic value) {
    if (value is String && value.isNotEmpty) {
      return DateTime.tryParse(value)?.toLocal();
    }
    return null;
  }
}

class LeaveStats {
  const LeaveStats({
    required this.pendingApprovals,
    required this.currentlyAway,
    required this.approvedPasses,
    required this.overdueCount,
  });

  final int pendingApprovals;
  final int currentlyAway;
  final int approvedPasses;
  final int overdueCount;

  static const empty = LeaveStats(
    pendingApprovals: 0,
    currentlyAway: 0,
    approvedPasses: 0,
    overdueCount: 0,
  );

  factory LeaveStats.fromJson(Map<String, dynamic> json) => LeaveStats(
        pendingApprovals: _int(json['pendingApprovals']),
        currentlyAway: _int(json['currentlyAway']),
        approvedPasses: _int(json['approvedPasses']),
        overdueCount: _int(json['overdueCount']),
      );

  static int _int(dynamic value) => value is num ? value.toInt() : 0;
}
