import 'package:flutter/material.dart';

import '../services/push.dart';
import '../services/reliability.dart';
import '../theme.dart';

/// Persistent warning when Android can silently swallow background alerts:
/// notifications blocked, or the app is still battery-optimised. Both are
/// actionable, and the banner never claims the socket path is affected.
class ReliabilityBanner extends StatefulWidget {
  const ReliabilityBanner({super.key});

  @override
  State<ReliabilityBanner> createState() => _ReliabilityBannerState();
}

class _ReliabilityBannerState extends State<ReliabilityBanner> {
  @override
  void initState() {
    super.initState();
    Reliability.refreshBattery();
  }

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<PushPermissionState>(
      valueListenable: PushService.instance.permission,
      builder: (context, permission, _) {
        return ValueListenableBuilder<bool?>(
          valueListenable: Reliability.batteryOptimized,
          builder: (context, optimized, _) {
            final notificationsBlocked =
                permission == PushPermissionState.denied;
            final batteryRisky = optimized == true;
            if (!notificationsBlocked && !batteryRisky) {
              return const SizedBox.shrink();
            }
            final message = notificationsBlocked
                ? 'Notifications are off. Background alerts will not ring.'
                : 'Battery optimisation is on. Android may delay alerts when '
                    'this app is closed.';
            return Padding(
              padding: const EdgeInsets.only(bottom: 10),
              child: Container(
                padding: const EdgeInsets.all(10),
                decoration: BoxDecoration(
                  color: AppColors.pending.withValues(alpha: 0.12),
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(
                    color: AppColors.pending.withValues(alpha: 0.45),
                  ),
                ),
                child: Row(
                  children: [
                    const Icon(
                      Icons.warning_amber_outlined,
                      size: 18,
                      color: AppColors.pending,
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        message,
                        style: const TextStyle(fontSize: 12),
                      ),
                    ),
                    TextButton(
                      style: TextButton.styleFrom(
                        foregroundColor: AppColors.pending,
                        padding: const EdgeInsets.symmetric(horizontal: 8),
                        minimumSize: const Size(0, 32),
                      ),
                      onPressed: notificationsBlocked
                          ? Reliability.openAppNotificationSettings
                          : Reliability.requestBatteryExemption,
                      child: Text(notificationsBlocked ? 'Fix' : 'Exempt'),
                    ),
                  ],
                ),
              ),
            );
          },
        );
      },
    );
  }
}
