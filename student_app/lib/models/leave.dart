/// One leave request as returned by `GET /leaves/my`.
///
/// The backend stores dates as ISO strings and leaves `reviewer`/`student`
/// as nested objects; this model keeps only what the student screens render.
class LeaveRequest {
  const LeaveRequest({
    required this.id,
    required this.type,
    required this.reason,
    required this.destination,
    required this.status,
    required this.departureTime,
    required this.expectedReturn,
    this.actualDeparture,
    this.actualReturn,
    this.gatePassCode,
    this.gatePassQr,
    this.reviewRemarks,
    this.reviewerName,
  });

  final String id;
  final String type;
  final String reason;
  final String destination;
  final String status;
  final DateTime departureTime;
  final DateTime expectedReturn;
  final DateTime? actualDeparture;
  final DateTime? actualReturn;
  final String? gatePassCode;
  final String? gatePassQr;
  final String? reviewRemarks;
  final String? reviewerName;

  factory LeaveRequest.fromJson(Map<String, dynamic> json) {
    final reviewer = json['reviewer'];
    return LeaveRequest(
      id: json['id'] as String,
      type: json['type'] as String? ?? 'OTHER',
      reason: json['reason'] as String? ?? '',
      destination: json['destination'] as String? ?? '',
      status: json['status'] as String? ?? 'SUBMITTED',
      departureTime: _date(json['departureTime']) ?? DateTime.now(),
      expectedReturn: _date(json['expectedReturn']) ?? DateTime.now(),
      actualDeparture: _date(json['actualDeparture']),
      actualReturn: _date(json['actualReturn']),
      gatePassCode: json['gatePassCode'] as String?,
      gatePassQr: json['gatePassQr'] as String?,
      reviewRemarks: json['reviewRemarks'] as String?,
      reviewerName: reviewer is Map ? reviewer['name'] as String? : null,
    );
  }

  static DateTime? _date(dynamic value) {
    if (value is! String || value.isEmpty) return null;
    return DateTime.tryParse(value)?.toLocal();
  }

  /// Approved or away: a gate pass exists and is worth showing.
  bool get hasActivePass => status == 'APPROVED' || status == 'DEPARTED';

  /// Only an unreviewed request can be withdrawn.
  bool get canCancel => status == 'SUBMITTED';

  String get statusLabel => switch (status) {
        'SUBMITTED' => 'Pending approval',
        'APPROVED' => 'Approved',
        'DEPARTED' => 'Away',
        'OVERDUE' => 'Overdue',
        'RETURNED' => 'Returned',
        'REJECTED' => 'Rejected',
        'CANCELLED' => 'Cancelled',
        _ => status,
      };

  String get typeLabel => switch (type) {
        'DAY_OUTING' => 'Day outing',
        'NIGHT_OUT' => 'Night out',
        'HOME_VISIT' => 'Home visit',
        'MEDICAL' => 'Medical',
        _ => type,
      };
}
