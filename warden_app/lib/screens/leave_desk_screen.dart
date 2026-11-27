import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../models/leave.dart';
import '../services/formatting.dart';
import '../state/app_scope.dart';
import '../state/leaves_controller.dart';
import '../theme.dart';
import '../widgets/common.dart';
import '../widgets/indicators.dart';
import 'leave_detail_sheet.dart';

enum _DeskTab { pending, approved, away, overdue, history }

class LeaveDeskScreen extends StatefulWidget {
  const LeaveDeskScreen({super.key});

  @override
  State<LeaveDeskScreen> createState() => _LeaveDeskScreenState();
}

class _LeaveDeskScreenState extends State<LeaveDeskScreen> {
  _DeskTab _tab = _DeskTab.pending;

  Future<void> _openGateCheck() async {
    final app = AppScope.read(context);
    final code = await showDialog<String>(
      context: context,
      builder: (_) => const _GateCheckDialog(),
    );
    if (code == null || !mounted) return;
    final outcome = await app.leaves.gateCheck(code);
    if (!mounted) return;
    final leave = outcome.leave;
    final message = switch (outcome.kind) {
      GateOutcomeKind.departed =>
        'Departure recorded for ${leave?.student.name ?? 'student'}'
            '${leave == null ? '' : ' (Room ${leave.student.roomNumber})'}.',
      GateOutcomeKind.returned =>
        'Return recorded for ${leave?.student.name ?? 'student'}.',
      GateOutcomeKind.notFound => outcome.message ?? 'Pass code not found.',
      GateOutcomeKind.error => outcome.message ?? 'Gate check failed.',
    };
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(message),
        backgroundColor:
            outcome.isSuccess ? AppColors.surfaceHigh : AppColors.pending,
      ),
    );
  }

  void _select(_DeskTab tab) {
    final controller = AppScope.read(context).leaves;
    setState(() => _tab = tab);
    if (tab == _DeskTab.pending) controller.markRequestsSeen();
  }

  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    final controller = app.leaves;

    return ListenableBuilder(
      listenable: controller,
      builder: (context, _) {
        final rows = switch (_tab) {
          _DeskTab.pending => controller.pending,
          _DeskTab.approved => controller.approved,
          _DeskTab.away => controller.away,
          _DeskTab.overdue => controller.overdue,
          _DeskTab.history => controller.history,
        };

        return Scaffold(
          appBar: AppBar(
            title: const Text(
              'Leaves',
              style: TextStyle(fontWeight: FontWeight.w700),
            ),
            actions: [
              const Padding(
                padding: EdgeInsets.only(right: 4),
                child: Center(child: ConnectionDot()),
              ),
              IconButton(
                tooltip: 'Refresh',
                onPressed: controller.loading
                    ? null
                    : () => controller.loadAll(),
                icon: const Icon(Icons.refresh),
              ),
              const SizedBox(width: 4),
            ],
          ),
          floatingActionButton: FloatingActionButton.extended(
            onPressed: controller.busyId == null ? _openGateCheck : null,
            backgroundColor: AppColors.accent,
            foregroundColor: Colors.white,
            icon: controller.busyId == 'gate'
                ? const SizedBox(
                    width: 16,
                    height: 16,
                    child: CircularProgressIndicator(
                      strokeWidth: 2,
                      color: Colors.white,
                    ),
                  )
                : const Icon(Icons.qr_code_scanner, size: 20),
            label: Text(controller.busyId == 'gate' ? 'Checking…' : 'Gate check'),
          ),
          body: RefreshIndicator(
            color: AppColors.accent,
            backgroundColor: AppColors.surface,
            onRefresh: () => controller.loadAll(),
            child: ListView(
              physics: const AlwaysScrollableScrollPhysics(),
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 96),
              children: [
                _StatsGrid(controller: controller),
                if (controller.hasNewRequests) ...[
                  const SizedBox(height: 10),
                  _NewRequestsBanner(
                    count: controller.pending.length,
                    onTap: () => _select(_DeskTab.pending),
                  ),
                ],
                if (controller.error != null) ...[
                  const SizedBox(height: 10),
                  ErrorBanner(
                    message: controller.error!,
                    onRetry: () => controller.loadAll(),
                  ),
                ],
                const SizedBox(height: 12),
                _TabStrip(
                  selected: _tab,
                  controller: controller,
                  onSelect: _select,
                ),
                if (_tab == _DeskTab.history) ...[
                  const SizedBox(height: 8),
                  _HistoryFilters(controller: controller),
                ],
                const SizedBox(height: 10),
                if (controller.loading && rows.isEmpty)
                  const Padding(
                    padding: EdgeInsets.symmetric(vertical: 48),
                    child: Center(child: CircularProgressIndicator()),
                  )
                else if (rows.isEmpty)
                  EmptyState(
                    icon: switch (_tab) {
                      _DeskTab.pending => Icons.inbox_outlined,
                      _DeskTab.approved => Icons.confirmation_number_outlined,
                      _DeskTab.away => Icons.directions_walk,
                      _DeskTab.overdue => Icons.timer_off_outlined,
                      _DeskTab.history => Icons.history,
                    },
                    title: switch (_tab) {
                      _DeskTab.pending => 'No requests waiting',
                      _DeskTab.approved => 'No approved passes',
                      _DeskTab.away => 'Everyone is on campus',
                      _DeskTab.overdue => 'No overdue returns',
                      _DeskTab.history => 'Nothing in this history filter',
                    },
                  )
                else
                  for (final leave in rows) ...[
                    _LeaveCard(
                      leave: leave,
                      onTap: () => showLeaveDetail(
                        context,
                        leaveId: leave.id,
                        onGateCheck: _openGateCheck,
                      ),
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
          ),
        );
      },
    );
  }
}

class _StatsGrid extends StatelessWidget {
  const _StatsGrid({required this.controller});

  final LeavesController controller;

  @override
  Widget build(BuildContext context) {
    final stats = controller.stats;
    return Column(
      children: [
        Row(
          children: [
            Expanded(
              child: StatCard(
                label: 'Pending approvals',
                value: '${stats.pendingApprovals}',
                color: AppColors.acknowledged,
              ),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: StatCard(
                label: 'Approved passes',
                value: '${stats.approvedPasses}',
                color: AppColors.resolved,
              ),
            ),
          ],
        ),
        const SizedBox(height: 8),
        Row(
          children: [
            Expanded(
              child: StatCard(
                label: 'Currently away',
                value: '${stats.currentlyAway}',
                color: AppColors.info,
              ),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: StatCard(
                label: 'Overdue',
                value: '${stats.overdueCount}',
                color: AppColors.pending,
              ),
            ),
          ],
        ),
      ],
    );
  }
}

class _NewRequestsBanner extends StatelessWidget {
  const _NewRequestsBanner({required this.count, required this.onTap});

  final int count;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: AppColors.acknowledged.withValues(alpha: 0.14),
      borderRadius: BorderRadius.circular(12),
      child: InkWell(
        borderRadius: BorderRadius.circular(12),
        onTap: onTap,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(12),
            border: Border.all(
              color: AppColors.acknowledged.withValues(alpha: 0.45),
            ),
          ),
          child: Row(
            children: [
              const Icon(
                Icons.notifications_active_outlined,
                size: 18,
                color: AppColors.acknowledged,
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  '$count new leave request${count == 1 ? '' : 's'} waiting for review',
                  style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600),
                ),
              ),
              const Text(
                'Review',
                style: TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w700,
                  color: AppColors.acknowledged,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _TabStrip extends StatelessWidget {
  const _TabStrip({
    required this.selected,
    required this.controller,
    required this.onSelect,
  });

  final _DeskTab selected;
  final LeavesController controller;
  final ValueChanged<_DeskTab> onSelect;

  @override
  Widget build(BuildContext context) {
    final tabs = [
      (_DeskTab.pending, 'Pending', controller.pending.length),
      (_DeskTab.approved, 'Approved', controller.approved.length),
      (_DeskTab.away, 'Away', controller.away.length),
      (_DeskTab.overdue, 'Overdue', controller.overdue.length),
      (_DeskTab.history, 'History', controller.history.length),
    ];
    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      child: Row(
        children: [
          for (final (tab, label, count) in tabs) ...[
            _TabChip(
              label: count == 0 ? label : '$label $count',
              selected: selected == tab,
              danger: tab == _DeskTab.overdue && count > 0,
              onTap: () => onSelect(tab),
            ),
            const SizedBox(width: 6),
          ],
        ],
      ),
    );
  }
}

class _TabChip extends StatelessWidget {
  const _TabChip({
    required this.label,
    required this.selected,
    required this.onTap,
    this.danger = false,
  });

  final String label;
  final bool selected;
  final VoidCallback onTap;
  final bool danger;

  @override
  Widget build(BuildContext context) {
    final accent = danger ? AppColors.pending : AppColors.accent;
    return Material(
      color: selected ? accent.withValues(alpha: 0.16) : AppColors.surface,
      borderRadius: BorderRadius.circular(10),
      child: InkWell(
        borderRadius: BorderRadius.circular(10),
        onTap: onTap,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(10),
            border: Border.all(
              color: selected
                  ? accent.withValues(alpha: 0.55)
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

class _HistoryFilters extends StatelessWidget {
  const _HistoryFilters({required this.controller});

  final LeavesController controller;

  @override
  Widget build(BuildContext context) {
    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      child: Row(
        children: [
          for (final filter in LeaveHistoryFilter.values) ...[
            ChoiceChip(
              label: Text(
                switch (filter) {
                  LeaveHistoryFilter.all => 'All',
                  LeaveHistoryFilter.returned => 'Returned',
                  LeaveHistoryFilter.rejected => 'Rejected',
                  LeaveHistoryFilter.cancelled => 'Cancelled',
                },
              ),
              selected: controller.historyFilter == filter,
              onSelected: (_) => controller.setHistoryFilter(filter),
            ),
            const SizedBox(width: 6),
          ],
        ],
      ),
    );
  }
}

class _LeaveCard extends StatelessWidget {
  const _LeaveCard({required this.leave, required this.onTap});

  final Leave leave;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final accent = statusColor(leave.status);
    final times = leave.expectedReturn == null
        ? ''
        : leave.isOverdue
            ? lateBy(leave.expectedReturn!)
            : 'due ${dayMonth(leave.expectedReturn)}';

    return Material(
      color: AppColors.surface,
      borderRadius: BorderRadius.circular(14),
      child: InkWell(
        borderRadius: BorderRadius.circular(14),
        onTap: onTap,
        child: Container(
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(14),
            border: Border(
              left: BorderSide(color: accent, width: 3),
              top: const BorderSide(color: AppColors.border),
              right: const BorderSide(color: AppColors.border),
              bottom: const BorderSide(color: AppColors.border),
            ),
          ),
          padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          leave.student.name,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                            fontWeight: FontWeight.w600,
                            fontSize: 14,
                          ),
                        ),
                        const SizedBox(height: 2),
                        Text(
                          'Room ${leave.student.roomNumber} · ${typeLabel(leave.type)}',
                          style: const TextStyle(
                            color: AppColors.muted,
                            fontSize: 12,
                          ),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(width: 8),
                  StatusPill(status: leave.status),
                ],
              ),
              const SizedBox(height: 6),
              Text(
                '${leave.destination} · ${leave.reason}',
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(color: AppColors.text, fontSize: 12),
              ),
              const SizedBox(height: 8),
              Wrap(
                spacing: 6,
                runSpacing: 6,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: [
                  Tag(
                    text: '${timeShort(leave.departureTime)} → ${timeShort(leave.expectedReturn)}',
                    icon: Icons.schedule,
                  ),
                  if (times.isNotEmpty)
                    Tag(
                      text: times,
                      icon: leave.isOverdue
                          ? Icons.timer_off_outlined
                          : Icons.event_available,
                      color: leave.isOverdue
                          ? AppColors.pending
                          : AppColors.muted,
                    ),
                  if ((leave.gatePassCode ?? '').isNotEmpty)
                    Tag(
                      text: leave.gatePassCode!,
                      icon: Icons.confirmation_number_outlined,
                      color: AppColors.resolved,
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

class _GateCheckDialog extends StatefulWidget {
  const _GateCheckDialog();

  @override
  State<_GateCheckDialog> createState() => _GateCheckDialogState();
}

class _GateCheckDialogState extends State<_GateCheckDialog> {
  final _controller = TextEditingController();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _submit() {
    final code = _controller.text.trim().toUpperCase();
    if (code.isEmpty) return;
    Navigator.of(context).pop(code);
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('Gate check'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text(
            'Enter the pass code from the student’s gate pass. Departure is '
            'recorded for approved passes; return for students who are away.',
            style: TextStyle(color: AppColors.muted, fontSize: 13),
          ),
          const SizedBox(height: 14),
          TextField(
            controller: _controller,
            autofocus: true,
            textCapitalization: TextCapitalization.characters,
            textInputAction: TextInputAction.done,
            inputFormatters: [
              FilteringTextInputFormatter.allow(RegExp(r'[A-Za-z0-9-]')),
              LengthLimitingTextInputFormatter(12),
            ],
            onSubmitted: (_) => _submit(),
            decoration: const InputDecoration(
              labelText: 'Gate pass code',
              hintText: 'HG-1A2B3C',
              prefixIcon: Icon(Icons.qr_code_2),
            ),
          ),
        ],
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: _submit,
          child: const Text('Record'),
        ),
      ],
    );
  }
}
