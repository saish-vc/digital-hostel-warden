import 'package:flutter/material.dart';

import '../services/socket.dart';
import '../theme.dart';

class ConnectionDot extends StatelessWidget {
  const ConnectionDot({super.key, this.compact = false});

  final bool compact;

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<SocketStatus>(
      valueListenable: SocketService.instance.status,
      builder: (context, status, _) {
        final (color, label) = switch (status) {
          SocketStatus.connected => (AppColors.resolved, 'Live'),
          SocketStatus.connecting => (AppColors.acknowledged, 'Connecting'),
          SocketStatus.disconnected => (AppColors.pending, 'Offline'),
        };
        return Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 8,
              height: 8,
              decoration: BoxDecoration(color: color, shape: BoxShape.circle),
            ),
            if (!compact) ...[
              const SizedBox(width: 6),
              Text(
                label,
                style: const TextStyle(fontSize: 12, color: AppColors.muted),
              ),
            ],
          ],
        );
      },
    );
  }
}

class EscalationPill extends StatelessWidget {
  const EscalationPill({super.key, required this.escalatedAt});

  final DateTime? escalatedAt;

  @override
  Widget build(BuildContext context) {
    final at = escalatedAt;
    if (at == null) return const SizedBox.shrink();
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 4),
      decoration: BoxDecoration(
        color: AppColors.pending.withValues(alpha: 0.16),
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: AppColors.pending.withValues(alpha: 0.5)),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Icon(Icons.sms_outlined, size: 13, color: AppColors.pending),
          const SizedBox(width: 5),
          Text(
            'SMS sent ${TimeOfDay.fromDateTime(at).format(context)}',
            style: const TextStyle(
              color: AppColors.pending,
              fontSize: 11,
              fontWeight: FontWeight.w600,
            ),
          ),
        ],
      ),
    );
  }
}
