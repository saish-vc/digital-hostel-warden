import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';

import '../models/leave.dart';
import '../services/formatting.dart';
import '../state/app_scope.dart';
import '../state/leaves_controller.dart';
import '../theme.dart';
import '../widgets/common.dart';

Future<void> showLeaveDetail(
  BuildContext context, {
  required String leaveId,
  required VoidCallback onGateCheck,
}) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    backgroundColor: AppColors.background,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
    ),
    builder: (_) => DraggableScrollableSheet(
      expand: false,
      initialChildSize: 0.88,
      minChildSize: 0.5,
      maxChildSize: 0.96,
      builder: (context, scrollController) => _LeaveDetailSheet(
        leaveId: leaveId,
        scrollController: scrollController,
        onGateCheck: onGateCheck,
      ),
    ),
  );
}

class _LeaveDetailSheet extends StatelessWidget {
  const _LeaveDetailSheet({
    required this.leaveId,
    required this.scrollController,
    required this.onGateCheck,
  });

  final String leaveId;
  final ScrollController scrollController;
  final VoidCallback onGateCheck;

  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    final controller = app.leaves;

    return ListenableBuilder(
      listenable: controller,
      builder: (context, _) {
        final leave = controller.byId(leaveId);
        if (leave == null) {
          return const EmptyState(
            icon: Icons.search_off,
            title: 'Request not available',
            subtitle: 'It may have been updated. Pull to refresh the desk.',
          );
        }
        return ListView(
          controller: scrollController,
          padding: const EdgeInsets.fromLTRB(18, 10, 18, 28),
          children: [
            Center(
              child: Container(
                width: 42,
                height: 4,
                margin: const EdgeInsets.only(bottom: 14),
                decoration: BoxDecoration(
                  color: AppColors.border,
                  borderRadius: BorderRadius.circular(2),
                ),
              ),
            ),
            _Header(leave: leave),
            const SizedBox(height: 14),
            _Timeline(leave: leave),
            const SizedBox(height: 14),
            _Details(leave: leave),
            if ((leave.reviewRemarks ?? '').isNotEmpty) ...[
              const SizedBox(height: 14),
              Container(
                width: double.infinity,
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: AppColors.acknowledged.withValues(alpha: 0.1),
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(
                    color: AppColors.acknowledged.withValues(alpha: 0.35),
                  ),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text(
                      'Review note',
                      style: TextStyle(
                        color: AppColors.acknowledged,
                        fontSize: 11,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      leave.reviewRemarks!,
                      style: const TextStyle(fontSize: 13),
                    ),
                    if (leave.reviewerName != null) ...[
                      const SizedBox(height: 4),
                      Text(
                        '— ${leave.reviewerName}',
                        style: const TextStyle(
                          color: AppColors.faint,
                          fontSize: 11,
                        ),
                      ),
                    ],
                  ],
                ),
              ),
            ],
            const SizedBox(height: 18),
            if (leave.isSubmitted)
              _ReviewActions(leave: leave, controller: controller)
            else if (leave.isApproved || leave.isAway) ...[
              FilledButton.icon(
                onPressed: () {
                  Navigator.of(context).pop();
                  WidgetsBinding.instance.addPostFrameCallback((_) => onGateCheck());
                },
                icon: const Icon(Icons.qr_code_scanner, size: 18),
                label: Text(
                  leave.isApproved ? 'Gate check · departure' : 'Gate check · return',
                ),
              ),
              const SizedBox(height: 8),
              const Text(
                'The guard reads the pass code aloud; enter it in Gate check to '
                'record the movement. The pass code is never accepted from this '
                'screen alone.',
                textAlign: TextAlign.center,
                style: TextStyle(color: AppColors.faint, fontSize: 11),
              ),
            ] else
              Container(
                padding: const EdgeInsets.symmetric(vertical: 12),
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  color: AppColors.surfaceHigh,
                  borderRadius: BorderRadius.circular(12),
                ),
                child: Text(
                  'Closed · ${statusLabel(leave.status)}',
                  style: const TextStyle(color: AppColors.muted, fontSize: 12),
                ),
              ),
          ],
        );
      },
    );
  }
}

class _Header extends StatelessWidget {
  const _Header({required this.leave});

  final Leave leave;

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Container(
          width: 46,
          height: 46,
          decoration: BoxDecoration(
            color: statusColor(leave.status).withValues(alpha: 0.15),
            borderRadius: BorderRadius.circular(14),
          ),
          child: Icon(
            Icons.luggage_outlined,
            color: statusColor(leave.status),
          ),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                leave.student.name,
                style: const TextStyle(fontSize: 19, fontWeight: FontWeight.w700),
              ),
              const SizedBox(height: 2),
              Text(
                'Room ${leave.student.roomNumber} · ${typeLabel(leave.type)}',
                style: const TextStyle(color: AppColors.muted, fontSize: 13),
              ),
              const SizedBox(height: 6),
              Wrap(
                spacing: 6,
                runSpacing: 6,
                children: [
                  StatusPill(status: leave.status),
                  if (leave.isOverdue && leave.expectedReturn != null)
                    Tag(
                      text: lateBy(leave.expectedReturn!),
                      icon: Icons.timer_off_outlined,
                      color: AppColors.pending,
                    ),
                ],
              ),
            ],
          ),
        ),
      ],
    );
  }
}

class _Timeline extends StatelessWidget {
  const _Timeline({required this.leave});

  final Leave leave;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: AppColors.border),
      ),
      child: Row(
        children: [
          Expanded(
            child: _Stop(
              label: 'Departure',
              value: dayMonth(leave.departureTime),
              done: leave.actualDeparture != null,
            ),
          ),
          const Padding(
            padding: EdgeInsets.symmetric(horizontal: 8),
            child: Icon(Icons.arrow_forward, size: 16, color: AppColors.faint),
          ),
          Expanded(
            child: _Stop(
              label: 'Expected return',
              value: dayMonth(leave.expectedReturn),
              done: leave.actualReturn != null,
              overdue: leave.isOverdue,
            ),
          ),
        ],
      ),
    );
  }
}

class _Stop extends StatelessWidget {
  const _Stop({
    required this.label,
    required this.value,
    required this.done,
    this.overdue = false,
  });

  final String label;
  final String value;
  final bool done;
  final bool overdue;

  @override
  Widget build(BuildContext context) {
    final color = overdue
        ? AppColors.pending
        : done
            ? AppColors.resolved
            : AppColors.text;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          label,
          style: const TextStyle(color: AppColors.faint, fontSize: 10),
        ),
        const SizedBox(height: 2),
        Text(
          value,
          style: TextStyle(color: color, fontSize: 12, fontWeight: FontWeight.w600),
        ),
      ],
    );
  }
}

class _Details extends StatelessWidget {
  const _Details({required this.leave});

  final Leave leave;

  Future<void> _call(BuildContext context) async {
    final digits = leave.emergencyContact.replaceAll(RegExp(r'[^0-9+]'), '');
    if (digits.isEmpty) return;
    final launched = await launchUrl(
      Uri.parse('tel:$digits'),
      mode: LaunchMode.externalApplication,
    );
    if (!launched && context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('No dialler available on this device.')),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: AppColors.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _Row(label: 'Destination', value: leave.destination),
          const Divider(height: 18),
          _Row(label: 'Reason', value: leave.reason),
          const Divider(height: 18),
          Row(
            children: [
              const SizedBox(
                width: 104,
                child: Text(
                  'Emergency contact',
                  style: TextStyle(color: AppColors.faint, fontSize: 12),
                ),
              ),
              Expanded(
                child: Text(
                  leave.emergencyContact.isEmpty
                      ? 'Not provided'
                      : leave.emergencyContact,
                  style: const TextStyle(fontSize: 12),
                ),
              ),
              if (leave.emergencyContact.isNotEmpty)
                IconButton(
                  tooltip: 'Call contact',
                  visualDensity: VisualDensity.compact,
                  onPressed: () => _call(context),
                  icon: const Icon(Icons.call, size: 18),
                ),
            ],
          ),
          const Divider(height: 18),
          Row(
            children: [
              const SizedBox(
                width: 104,
                child: Text(
                  'Parent consent',
                  style: TextStyle(color: AppColors.faint, fontSize: 12),
                ),
              ),
              Icon(
                leave.parentConsent ? Icons.check_circle : Icons.cancel_outlined,
                size: 16,
                color: leave.parentConsent
                    ? AppColors.resolved
                    : AppColors.pending,
              ),
              const SizedBox(width: 5),
              Text(
                leave.parentConsent ? 'Recorded' : 'Missing',
                style: const TextStyle(fontSize: 12),
              ),
            ],
          ),
          if ((leave.gatePassCode ?? '').isNotEmpty) ...[
            const Divider(height: 18),
            Row(
              children: [
                const SizedBox(
                  width: 104,
                  child: Text(
                    'Gate pass',
                    style: TextStyle(color: AppColors.faint, fontSize: 12),
                  ),
                ),
                Expanded(
                  child: Text(
                    leave.gatePassCode!,
                    style: const TextStyle(
                      fontFamily: 'monospace',
                      fontSize: 14,
                      fontWeight: FontWeight.w700,
                      letterSpacing: 1.2,
                    ),
                  ),
                ),
                IconButton(
                  tooltip: 'Copy pass code',
                  visualDensity: VisualDensity.compact,
                  onPressed: () {
                    Clipboard.setData(
                      ClipboardData(text: leave.gatePassCode!),
                    );
                    ScaffoldMessenger.of(context).showSnackBar(
                      const SnackBar(content: Text('Gate pass code copied.')),
                    );
                  },
                  icon: const Icon(Icons.copy, size: 18),
                ),
              ],
            ),
          ],
          if (leave.actualDeparture != null) ...[
            const Divider(height: 18),
            _Row(
              label: 'Left at',
              value: dateMedium(leave.actualDeparture),
            ),
          ],
          if (leave.actualReturn != null) ...[
            const Divider(height: 18),
            _Row(
              label: 'Returned at',
              value: dateMedium(leave.actualReturn),
            ),
          ],
        ],
      ),
    );
  }
}

class _Row extends StatelessWidget {
  const _Row({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SizedBox(
          width: 104,
          child: Text(
            label,
            style: const TextStyle(color: AppColors.faint, fontSize: 12),
          ),
        ),
        Expanded(
          child: Text(value, style: const TextStyle(fontSize: 12)),
        ),
      ],
    );
  }
}

class _ReviewActions extends StatelessWidget {
  const _ReviewActions({required this.leave, required this.controller});

  final Leave leave;
  final LeavesController controller;

  Future<void> _review(BuildContext context, String decision) async {
    final note = await _askNote(context, decision);
    if (note == null || !context.mounted) return;
    final ok = await controller.review(
      leave.id,
      decision,
      remarks: note.isEmpty ? null : note,
    );
    if (!context.mounted) return;
    final updated = controller.byId(leave.id);
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(
          ok
              ? decision == 'APPROVED'
                  ? 'Approved. Gate pass ${updated?.gatePassCode ?? 'issued'}.'
                  : 'Request rejected.'
              : controller.error ?? 'Could not update the request.',
        ),
      ),
    );
  }

  Future<String?> _askNote(BuildContext context, String decision) async {
    final controller = TextEditingController();
    final approving = decision == 'APPROVED';
    return showDialog<String>(
      context: context,
      builder: (dialogContext) {
        return StatefulBuilder(
          builder: (context, setDialogState) {
            return AlertDialog(
              title: Text(approving ? 'Approve request' : 'Reject request'),
              content: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    approving
                        ? 'A gate pass code is issued and the student is notified.'
                        : 'The student sees this decision with your note.',
                    style: const TextStyle(color: AppColors.muted, fontSize: 13),
                  ),
                  const SizedBox(height: 12),
                  TextField(
                    controller: controller,
                    autofocus: true,
                    maxLength: 500,
                    maxLines: 3,
                    minLines: 2,
                    decoration: InputDecoration(
                      labelText: approving ? 'Note (optional)' : 'Reason (optional)',
                      hintText: approving
                          ? 'e.g. Parent confirmed by phone'
                          : 'e.g. Return time clashes with exam',
                    ),
                    onChanged: (_) => setDialogState(() {}),
                  ),
                ],
              ),
              actions: [
                TextButton(
                  onPressed: () => Navigator.of(dialogContext).pop(),
                  child: const Text('Cancel'),
                ),
                FilledButton(
                  style: approving
                      ? null
                      : FilledButton.styleFrom(backgroundColor: AppColors.pending),
                  onPressed: controller.text.trim().length > 500
                      ? null
                      : () => Navigator.of(dialogContext)
                          .pop(controller.text.trim()),
                  child: Text(approving ? 'Approve & issue pass' : 'Reject'),
                ),
              ],
            );
          },
        );
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    final busy = controller.busyId != null;
    return Row(
      children: [
        Expanded(
          child: OutlinedButton.icon(
            onPressed: busy ? null : () => _review(context, 'REJECTED'),
            style: OutlinedButton.styleFrom(
              foregroundColor: AppColors.pending,
              side: BorderSide(color: AppColors.pending.withValues(alpha: 0.5)),
              padding: const EdgeInsets.symmetric(vertical: 14),
            ),
            icon: const Icon(Icons.close, size: 18),
            label: const Text('Reject'),
          ),
        ),
        const SizedBox(width: 10),
        Expanded(
          child: FilledButton.icon(
            style: FilledButton.styleFrom(backgroundColor: AppColors.resolved),
            onPressed: busy ? null : () => _review(context, 'APPROVED'),
            icon: busy
                ? const SizedBox(
                    width: 16,
                    height: 16,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.check, size: 18),
            label: const Text('Approve'),
          ),
        ),
      ],
    );
  }
}
