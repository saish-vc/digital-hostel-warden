import 'package:flutter/material.dart';

import '../services/formatting.dart';
import '../state/alerts_controller.dart';
import '../state/app_scope.dart';
import '../theme.dart';
import '../widgets/alert_card.dart';
import '../widgets/common.dart';
import '../widgets/indicators.dart';
import '../widgets/reliability_banner.dart';
import 'alert_detail_screen.dart';

class BoardScreen extends StatelessWidget {
  const BoardScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    final controller = app.alerts;

    return Scaffold(
      appBar: AppBar(
        title: const Text(
          'Alerts',
          style: TextStyle(fontWeight: FontWeight.w700),
        ),
        actions: [
          const Padding(
            padding: EdgeInsets.only(right: 4),
            child: Center(child: ConnectionDot()),
          ),
          IconButton(
            tooltip: 'Refresh',
            onPressed: controller.loading ? null : () => controller.load(),
            icon: const Icon(Icons.refresh),
          ),
          const SizedBox(width: 4),
        ],
      ),
      body: ListenableBuilder(
        listenable: controller,
        builder: (context, _) {
          return RefreshIndicator(
            color: AppColors.accent,
            backgroundColor: AppColors.surface,
            onRefresh: app.reloadAll,
            child: ListView(
              physics: const AlwaysScrollableScrollPhysics(),
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
              children: [
                _StatsRow(controller: controller),
                const SizedBox(height: 12),
                const ReliabilityBanner(),
                _UnseenBanner(controller: controller),
                _FilterRow(controller: controller),
                if (controller.error != null) ...[
                  const SizedBox(height: 10),
                  ErrorBanner(
                    message: controller.error!,
                    onRetry: () => controller.load(),
                  ),
                ],
                const SizedBox(height: 10),
                if (controller.loading && controller.alerts.isEmpty)
                  const Padding(
                    padding: EdgeInsets.symmetric(vertical: 56),
                    child: Center(child: CircularProgressIndicator()),
                  )
                else if (controller.visibleAlerts.isEmpty)
                  EmptyState(
                    icon: controller.filter == AlertFilter.resolved
                        ? Icons.task_alt
                        : Icons.verified_user_outlined,
                    title: switch (controller.filter) {
                      AlertFilter.active => 'No active alerts',
                      AlertFilter.resolved => 'Nothing resolved yet',
                      AlertFilter.all => 'No alerts yet',
                    },
                    subtitle: controller.filter == AlertFilter.active
                        ? 'New SOS alerts arrive here in real time.'
                        : null,
                  )
                else
                  for (final alert in controller.visibleAlerts) ...[
                    AlertCard(
                      alert: alert,
                      onTap: () {
                        Navigator.of(context).push(
                          MaterialPageRoute<void>(
                            builder: (_) => AlertDetailScreen(alertId: alert.id),
                          ),
                        );
                      },
                    ),
                    const SizedBox(height: 8),
                  ],
                const SizedBox(height: 6),
                Center(
                  child: Text(
                    controller.lastUpdated == null
                        ? 'Waiting for the first sync…'
                        : 'Updated ${timeHms(controller.lastUpdated)} · pull to refresh',
                    style: const TextStyle(color: AppColors.faint, fontSize: 11),
                  ),
                ),
              ],
            ),
          );
        },
      ),
    );
  }
}

class _StatsRow extends StatelessWidget {
  const _StatsRow({required this.controller});

  final AlertsController controller;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Expanded(
          child: StatCard(
            label: 'Pending',
            value: '${controller.pendingCount}',
            color: AppColors.pending,
          ),
        ),
        const SizedBox(width: 8),
        Expanded(
          child: StatCard(
            label: 'Responding',
            value: '${controller.respondingCount}',
            color: AppColors.acknowledged,
          ),
        ),
        const SizedBox(width: 8),
        Expanded(
          child: StatCard(
            label: 'Resolved today',
            value: '${controller.resolvedTodayCount}',
            color: AppColors.resolved,
          ),
        ),
      ],
    );
  }
}

class _FilterRow extends StatelessWidget {
  const _FilterRow({required this.controller});

  final AlertsController controller;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        for (final filter in AlertFilter.values) ...[
          Expanded(
            child: Padding(
              padding: const EdgeInsets.only(right: 6),
              child: _FilterButton(
                label: switch (filter) {
                  AlertFilter.active => 'Active',
                  AlertFilter.resolved => 'Resolved',
                  AlertFilter.all => 'All',
                },
                selected: controller.filter == filter,
                onTap: () => controller.setFilter(filter),
              ),
            ),
          ),
        ],
      ],
    );
  }
}

class _FilterButton extends StatelessWidget {
  const _FilterButton({
    required this.label,
    required this.selected,
    required this.onTap,
  });

  final String label;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: selected
          ? AppColors.accent.withValues(alpha: 0.16)
          : AppColors.surface,
      borderRadius: BorderRadius.circular(10),
      child: InkWell(
        borderRadius: BorderRadius.circular(10),
        onTap: onTap,
        child: Container(
          padding: const EdgeInsets.symmetric(vertical: 9),
          alignment: Alignment.center,
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(10),
            border: Border.all(
              color: selected
                  ? AppColors.accent.withValues(alpha: 0.55)
                  : AppColors.border,
            ),
          ),
          child: Text(
            label,
            style: TextStyle(
              fontSize: 12,
              fontWeight: FontWeight.w600,
              color: selected ? AppColors.text : AppColors.muted,
            ),
          ),
        ),
      ),
    );
  }
}

class _UnseenBanner extends StatelessWidget {
  const _UnseenBanner({required this.controller});

  final AlertsController controller;

  @override
  Widget build(BuildContext context) {
    if (controller.unseenCount == 0 || controller.filter == AlertFilter.active) {
      return const SizedBox.shrink();
    }
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Material(
        color: AppColors.pending.withValues(alpha: 0.14),
        borderRadius: BorderRadius.circular(12),
        child: InkWell(
          borderRadius: BorderRadius.circular(12),
          onTap: () => controller.setFilter(AlertFilter.active),
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(12),
              border: Border.all(
                color: AppColors.pending.withValues(alpha: 0.45),
              ),
            ),
            child: Row(
              children: [
                const Icon(
                  Icons.notifications_active_outlined,
                  size: 18,
                  color: AppColors.pending,
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    '${controller.unseenCount} new alert'
                    '${controller.unseenCount == 1 ? '' : 's'} waiting',
                    style: const TextStyle(
                      fontSize: 12,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
                const Text(
                  'Show',
                  style: TextStyle(
                    fontSize: 12,
                    color: AppColors.pending,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

