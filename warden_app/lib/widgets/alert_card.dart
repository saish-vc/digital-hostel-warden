import 'package:flutter/material.dart';

import '../models/alert.dart';
import '../services/formatting.dart';
import '../theme.dart';
import 'common.dart';
import 'indicators.dart';

IconData iconForType(String type) {
  if (type.startsWith('OFF_CAMPUS_LEAVE:')) return Icons.directions_walk;
  switch (type) {
    case 'MEDICAL':
      return Icons.medical_services_outlined;
    case 'FIRE':
      return Icons.local_fire_department_outlined;
    case 'SECURITY':
      return Icons.shield_outlined;
    case 'MENTAL_HEALTH':
      return Icons.psychology_outlined;
    default:
      return Icons.report_outlined;
  }
}

class AlertCard extends StatelessWidget {
  const AlertCard({
    super.key,
    required this.alert,
    required this.onTap,
    this.selected = false,
  });

  final Alert alert;
  final VoidCallback onTap;
  final bool selected;

  @override
  Widget build(BuildContext context) {
    final accent = statusColor(alert.status);
    return Material(
      color: selected ? AppColors.surfaceHigh : AppColors.surface,
      borderRadius: BorderRadius.circular(14),
      child: InkWell(
        borderRadius: BorderRadius.circular(14),
        onTap: onTap,
        child: Container(
          decoration: BoxDecoration(
            border: Border(
              left: BorderSide(color: accent, width: 3),
              top: const BorderSide(color: AppColors.border),
              right: const BorderSide(color: AppColors.border),
              bottom: const BorderSide(color: AppColors.border),
            ),
            borderRadius: BorderRadius.circular(14),
          ),
          padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Container(
                    width: 34,
                    height: 34,
                    decoration: BoxDecoration(
                      color: accent.withValues(alpha: 0.14),
                      borderRadius: BorderRadius.circular(10),
                    ),
                    child: Icon(iconForType(alert.type), color: accent, size: 19),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          alert.student.name.isEmpty ? 'Unknown student' : alert.student.name,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                            fontWeight: FontWeight.w600,
                            fontSize: 14,
                          ),
                        ),
                        const SizedBox(height: 2),
                        Text(
                          'Room ${alert.student.roomNumber} · ${typeLabel(alert.type)}',
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                            color: AppColors.muted,
                            fontSize: 12,
                          ),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(width: 8),
                  Column(
                    crossAxisAlignment: CrossAxisAlignment.end,
                    children: [
                      StatusPill(status: alert.status),
                      const SizedBox(height: 4),
                      Text(
                        timeHms(alert.createdAt),
                        style: const TextStyle(
                          color: AppColors.faint,
                          fontSize: 11,
                          fontFeatures: [FontFeature.tabularFigures()],
                        ),
                      ),
                    ],
                  ),
                ],
              ),
              const SizedBox(height: 8),
              Wrap(
                spacing: 6,
                runSpacing: 6,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: [
                  if (alert.hasLocation)
                    const Tag(text: 'GPS', icon: Icons.gps_fixed)
                  else
                    const Tag(text: 'No GPS', icon: Icons.gps_off),
                  if (alert.isActive)
                    Tag(
                      text: elapsedSince(alert.createdAt),
                      icon: Icons.timer_outlined,
                      color: accent,
                    ),
                  if (alert.escalatedAt != null) EscalationPill(escalatedAt: alert.escalatedAt),
                  if (alert.offCampusLeave != null)
                    Tag(
                      text: 'On leave · ${alert.offCampusLeave!.destination}',
                      icon: Icons.luggage_outlined,
                    ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}
