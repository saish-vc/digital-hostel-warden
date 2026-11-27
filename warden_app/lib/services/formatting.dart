import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../theme.dart';

String typeLabel(String type) {
  if (type.startsWith('OFF_CAMPUS_LEAVE:')) {
    final inner = type.substring('OFF_CAMPUS_LEAVE:'.length);
    return 'Leave · ${typeLabel(inner)}';
  }
  switch (type) {
    case 'MEDICAL':
      return 'Medical';
    case 'FIRE':
      return 'Fire';
    case 'SECURITY':
      return 'Security';
    case 'MENTAL_HEALTH':
      return 'Mental health';
    case 'OTHER':
      return 'Other';
    case 'DAY_OUTING':
      return 'Day outing';
    case 'NIGHT_OUT':
      return 'Night out';
    case 'HOME_VISIT':
      return 'Home visit';
    default:
      return type.isEmpty ? 'Unknown' : type;
  }
}

String statusLabel(String status) {
  switch (status) {
    case 'PENDING':
      return 'Pending';
    case 'ACKNOWLEDGED':
      return 'Acknowledged';
    case 'RESOLVED':
      return 'Resolved';
    case 'SUBMITTED':
      return 'Pending approval';
    case 'APPROVED':
      return 'Approved';
    case 'REJECTED':
      return 'Rejected';
    case 'DEPARTED':
      return 'Away';
    case 'RETURNED':
      return 'Returned';
    case 'OVERDUE':
      return 'Overdue';
    case 'CANCELLED':
      return 'Cancelled';
    default:
      return status;
  }
}

Color statusColor(String status) {
  switch (status) {
    case 'PENDING':
    case 'OVERDUE':
      return AppColors.pending;
    case 'ACKNOWLEDGED':
    case 'SUBMITTED':
      return AppColors.acknowledged;
    case 'RESOLVED':
    case 'RETURNED':
    case 'APPROVED':
      return AppColors.resolved;
    case 'REJECTED':
      return AppColors.pending;
    case 'CANCELLED':
      return AppColors.faint;
    default:
      return AppColors.info;
  }
}

String timeHms(DateTime? value) =>
    value == null ? '—' : DateFormat('HH:mm:ss').format(value);

String timeShort(DateTime? value) =>
    value == null ? '—' : DateFormat('HH:mm').format(value);

String dateMedium(DateTime? value) =>
    value == null ? '—' : DateFormat('d MMM y, HH:mm').format(value);

String dayMonth(DateTime? value) =>
    value == null ? '—' : DateFormat('dd MMM, HH:mm').format(value);

String dayOnly(DateTime? value) =>
    value == null ? '—' : DateFormat('dd MMM y').format(value);

String elapsedSince(DateTime value, {DateTime? now}) {
  final diff = (now ?? DateTime.now()).difference(value);
  if (diff.inSeconds < 30) return 'just now';
  if (diff.inMinutes < 1) return '${diff.inSeconds}s ago';
  if (diff.inMinutes < 60) return '${diff.inMinutes}m ago';
  if (diff.inHours < 24) return '${diff.inHours}h ${diff.inMinutes % 60}m ago';
  return '${diff.inDays}d ${diff.inHours % 24}h ago';
}

String lateBy(DateTime expected, {DateTime? now}) {
  final diff = (now ?? DateTime.now()).difference(expected);
  if (diff.isNegative) return 'on time';
  final hours = diff.inHours;
  final minutes = diff.inMinutes % 60;
  if (hours <= 0) return '${minutes}m late';
  return '${hours}h ${minutes.toString().padLeft(2, '0')}m late';
}

/// Local calendar day, converted to the UTC instant the API compares against.
/// (The web dashboard sends UTC day bounds, which shifts the range for
/// non-UTC wardens; this is the deliberate fix.)
DateTime localDayStart(DateTime day) =>
    DateTime(day.year, day.month, day.day);

DateTime localDayEnd(DateTime day) =>
    DateTime(day.year, day.month, day.day, 23, 59, 59, 999);

String isoUtc(DateTime value) => value.toUtc().toIso8601String();

String initials(String name) {
  final parts = name.trim().split(RegExp(r'\s+')).where((p) => p.isNotEmpty);
  if (parts.isEmpty) return '?';
  final first = parts.first.substring(0, 1);
  final last = parts.length > 1 ? parts.last.substring(0, 1) : '';
  return (first + last).toUpperCase();
}

String coordLabel(double? lat, double? lng) {
  if (lat == null || lng == null) return 'No GPS';
  return '${lat.toStringAsFixed(5)}, ${lng.toStringAsFixed(5)}';
}

String accuracyLabel(double? accuracy) {
  if (accuracy == null || accuracy <= 0) return '';
  return '±${accuracy.round()} m';
}
