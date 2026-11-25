import 'package:flutter/material.dart';

import '../models/leave.dart';
import '../services/api.dart';
import '../services/socket.dart';
import 'gate_pass_qr_screen.dart';
import 'leave_apply_screen.dart';

/// Student's leave history: every request with its status, plus the entry
/// points to apply for a new leave and to open an approved gate pass.
class LeaveStatusScreen extends StatefulWidget {
  const LeaveStatusScreen({super.key});

  @override
  State<LeaveStatusScreen> createState() => _LeaveStatusScreenState();
}

class _LeaveStatusScreenState extends State<LeaveStatusScreen> {
  bool _loading = true;
  String? _error;
  List<LeaveRequest> _leaves = const [];

  @override
  void initState() {
    super.initState();
    _load();
    _connectSocket();
  }

  @override
  void dispose() {
    SocketService.instance.disconnect();
    super.dispose();
  }

  /// Live status: approval, rejection, cancellation, departure and return are
  /// pushed by the server to `student:<id>`. A silent reload keeps the list on
  /// screen instead of flashing the loading state for every event.
  Future<void> _connectSocket() async {
    final token = await ApiService.token;
    if (token == null || !mounted) return;

    SocketService.instance.connect(
      token,
      onAlertUpdated: (_) {},
      onLeaveEvent: (_) {
        if (!mounted) return;
        _load(silent: true);
      },
    );
  }

  Future<void> _load({bool silent = false}) async {
    if (!silent) {
      setState(() {
        _loading = true;
        _error = null;
      });
    }

    try {
      final rows = await ApiService.myLeaves();
      if (!mounted) return;
      setState(() {
        _leaves = rows.map(LeaveRequest.fromJson).toList(growable: false);
        _loading = false;
        _error = null;
      });
    } on ApiException catch (error) {
      if (!mounted || silent) return;
      setState(() {
        _error = error.message;
        _loading = false;
      });
    } catch (_) {
      if (!mounted || silent) return;
      setState(() {
        _error = 'Could not reach the hostel server.';
        _loading = false;
      });
    }
  }

  Future<void> _openApply() async {
    final created = await Navigator.of(context).push<bool>(
      MaterialPageRoute(builder: (_) => const LeaveApplyScreen()),
    );
    if (created == true) await _load();
  }

  Future<void> _openPass(LeaveRequest leave) async {
    await Navigator.of(context).push(
      MaterialPageRoute(builder: (_) => GatePassScreen(leaveId: leave.id)),
    );
    // The pass screen may have recorded an off-campus SOS or the warden may
    // have marked departure while it was open; reload so the list agrees.
    await _load();
    // The SOS confirmation screen owns the shared socket, so re-attach the
    // status listeners when we come back.
    await _connectSocket();
  }

  Future<void> _cancel(LeaveRequest leave) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        backgroundColor: const Color(0xFF111827),
        title: const Text('Cancel this request?', style: TextStyle(color: Colors.white)),
        content: Text(
          'The warden has not reviewed it yet. Cancelling cannot be undone.\n\n'
          '${leave.typeLabel} — ${leave.destination}',
          style: const TextStyle(color: Colors.white70),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: const Text('Keep it'),
          ),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: Colors.red.shade700),
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: const Text('Cancel request'),
          ),
        ],
      ),
    );

    if (confirmed != true) return;

    try {
      await ApiService.cancelLeave(leave.id);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Leave request cancelled.')),
      );
      await _load();
    } on ApiException catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(error.message), backgroundColor: Colors.red.shade800),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFF0B1120),
      appBar: AppBar(
        backgroundColor: Colors.transparent,
        elevation: 0,
        title: const Text('My leaves'),
        actions: [
          IconButton(
            onPressed: _loading ? null : _load,
            icon: const Icon(Icons.refresh),
            tooltip: 'Refresh',
          ),
        ],
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _openApply,
        backgroundColor: Colors.red.shade700,
        foregroundColor: Colors.white,
        icon: const Icon(Icons.add),
        label: const Text('Apply for leave'),
      ),
      body: SafeArea(child: _body()),
    );
  }

  Widget _body() {
    if (_loading) {
      return const Center(child: CircularProgressIndicator(color: Colors.redAccent));
    }

    if (_error != null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.cloud_off, size: 48, color: Colors.redAccent),
              const SizedBox(height: 12),
              Text(
                _error!,
                textAlign: TextAlign.center,
                style: const TextStyle(color: Colors.white70),
              ),
              const SizedBox(height: 16),
              FilledButton(onPressed: _load, child: const Text('Try again')),
            ],
          ),
        ),
      );
    }

    if (_leaves.isEmpty) {
      return RefreshIndicator(
        onRefresh: _load,
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          children: const [
            SizedBox(height: 120),
            Icon(Icons.luggage_outlined, size: 64, color: Colors.white24),
            SizedBox(height: 16),
            Center(
              child: Text(
                'No leave requests yet',
                style: TextStyle(color: Colors.white, fontSize: 18, fontWeight: FontWeight.bold),
              ),
            ),
            SizedBox(height: 8),
            Padding(
              padding: EdgeInsets.symmetric(horizontal: 32),
              child: Text(
                'Apply for a day outing, night out, home visit or medical leave. '
                'Once a warden approves it, your gate pass appears here.',
                textAlign: TextAlign.center,
                style: TextStyle(color: Colors.white54),
              ),
            ),
          ],
        ),
      );
    }

    return RefreshIndicator(
      onRefresh: _load,
      child: ListView.separated(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 96),
        itemCount: _leaves.length,
        separatorBuilder: (_, __) => const SizedBox(height: 12),
        itemBuilder: (context, index) {
          final leave = _leaves[index];
          return _LeaveCard(
            leave: leave,
            onOpenPass: leave.hasActivePass ? () => _openPass(leave) : null,
            onCancel: leave.canCancel ? () => _cancel(leave) : null,
          );
        },
      ),
    );
  }
}

class _LeaveCard extends StatelessWidget {
  const _LeaveCard({required this.leave, this.onOpenPass, this.onCancel});

  final LeaveRequest leave;
  final VoidCallback? onOpenPass;
  final VoidCallback? onCancel;

  @override
  Widget build(BuildContext context) {
    final accent = _statusColor(leave.status);

    return Container(
      decoration: BoxDecoration(
        color: const Color(0xFF111827),
        borderRadius: BorderRadius.circular(18),
        border: Border.all(
          color: leave.status == 'OVERDUE' ? Colors.red.shade700 : const Color(0xFF1F2937),
        ),
      ),
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  leave.typeLabel,
                  style: const TextStyle(
                    color: Colors.white,
                    fontSize: 17,
                    fontWeight: FontWeight.bold,
                  ),
                ),
              ),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                decoration: BoxDecoration(
                  color: accent.withValues(alpha: 0.16),
                  borderRadius: BorderRadius.circular(999),
                  border: Border.all(color: accent.withValues(alpha: 0.6)),
                ),
                child: Text(
                  leave.statusLabel,
                  style: TextStyle(color: accent, fontSize: 12, fontWeight: FontWeight.bold),
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          Row(
            children: [
              const Icon(Icons.place_outlined, size: 16, color: Colors.white54),
              const SizedBox(width: 6),
              Expanded(
                child: Text(
                  leave.destination,
                  style: const TextStyle(color: Colors.white70),
                ),
              ),
            ],
          ),
          const SizedBox(height: 4),
          Row(
            children: [
              const Icon(Icons.schedule, size: 16, color: Colors.white54),
              const SizedBox(width: 6),
              Expanded(
                child: Text(
                  '${_formatDateTime(leave.departureTime)} → ${_formatDateTime(leave.expectedReturn)}',
                  style: const TextStyle(color: Colors.white54, fontSize: 13),
                ),
              ),
            ],
          ),
          if (leave.reason.isNotEmpty) ...[
            const SizedBox(height: 8),
            Text(
              leave.reason,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(color: Colors.white38, fontSize: 13),
            ),
          ],
          if (leave.reviewRemarks != null && leave.reviewRemarks!.isNotEmpty) ...[
            const SizedBox(height: 8),
            Text(
              'Warden: ${leave.reviewRemarks}',
              style: const TextStyle(color: Colors.amber, fontSize: 13),
            ),
          ],
          if (leave.status == 'DEPARTED' && leave.actualDeparture != null) ...[
            const SizedBox(height: 8),
            Text(
              'Left the gate at ${_formatDateTime(leave.actualDeparture!)}',
              style: const TextStyle(color: Colors.lightBlueAccent, fontSize: 13),
            ),
          ],
          if (onOpenPass != null || onCancel != null) ...[
            const SizedBox(height: 12),
            Row(
              children: [
                if (onOpenPass != null)
                  Expanded(
                    child: FilledButton.icon(
                      onPressed: onOpenPass,
                      style: FilledButton.styleFrom(
                        backgroundColor: Colors.green.shade700,
                        foregroundColor: Colors.white,
                      ),
                      icon: const Icon(Icons.qr_code_2),
                      label: Text(
                        leave.status == 'DEPARTED' ? 'View gate pass' : 'Show gate pass',
                      ),
                    ),
                  ),
                if (onOpenPass != null && onCancel != null) const SizedBox(width: 10),
                if (onCancel != null)
                  Expanded(
                    child: OutlinedButton.icon(
                      onPressed: onCancel,
                      style: OutlinedButton.styleFrom(foregroundColor: Colors.white70),
                      icon: const Icon(Icons.close),
                      label: const Text('Cancel'),
                    ),
                  ),
              ],
            ),
          ],
        ],
      ),
    );
  }

  static Color _statusColor(String status) => switch (status) {
        'SUBMITTED' => Colors.amber,
        'APPROVED' => Colors.greenAccent,
        'DEPARTED' => Colors.lightBlueAccent,
        'OVERDUE' => Colors.redAccent,
        'RETURNED' => Colors.white70,
        'REJECTED' => Colors.redAccent,
        'CANCELLED' => Colors.white38,
        _ => Colors.white70,
      };
}

const _months = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

String _formatDateTime(DateTime value) {
  final local = value.toLocal();
  final hour = local.hour.toString().padLeft(2, '0');
  final minute = local.minute.toString().padLeft(2, '0');
  return '${local.day} ${_months[local.month - 1]}, $hour:$minute';
}
