import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';

import '../services/formatting.dart';
import '../services/notifications.dart';
import '../state/app_scope.dart';
import '../theme.dart';
import '../widgets/common.dart';
import '../widgets/indicators.dart';
import 'alert_detail_screen.dart';

/// Full-screen alarm shown when a new alert arrives while the app is in the
/// foreground. It rings until the warden acknowledges it or explicitly
/// dismisses the sheet — dismissing is not an acknowledgement.
///
/// The alert is re-fetched before the screen trusts it: a push payload can be
/// stale, and a resolved case must show "already handled" instead of ringing.
class AlarmScreen extends StatefulWidget {
  const AlarmScreen({super.key, required this.alertId});

  final String alertId;

  @override
  State<AlarmScreen> createState() => _AlarmScreenState();
}

class _AlarmScreenState extends State<AlarmScreen> {
  Timer? _ringer;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _ringOnce();
    _ringer = Timer.periodic(const Duration(seconds: 2), (_) => _ringOnce());
    WidgetsBinding.instance.addPostFrameCallback((_) => _refresh());
  }

  @override
  void dispose() {
    _ringer?.cancel();
    super.dispose();
  }

  void _ringOnce() {
    SystemSound.play(SystemSoundType.alert);
    HapticFeedback.heavyImpact();
  }

  Future<void> _refresh() async {
    if (!mounted) return;
    final app = AppScope.read(context);
    await app.alerts.load(silent: true);
    if (!mounted) return;
    final alert = app.alerts.byId(widget.alertId);
    if (alert != null && alert.isResolved) {
      _stopRinging();
      await NotificationService.cancel(alert.id);
    }
  }

  void _stopRinging() {
    _ringer?.cancel();
    _ringer = null;
  }

  Future<void> _acknowledge() async {
    final app = AppScope.read(context);
    setState(() => _busy = true);
    final ok = await app.alerts.acknowledge(widget.alertId);
    if (!mounted) return;
    setState(() => _busy = false);
    if (ok) {
      _stopRinging();
      await NotificationService.cancel(widget.alertId);
    }
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(
          ok
              ? 'Alert acknowledged. The 60 s SMS escalation is cancelled.'
              : app.alerts.error ?? 'Could not acknowledge the alert.',
        ),
      ),
    );
  }

  Future<void> _dismiss() async {
    _stopRinging();
    await NotificationService.cancel(widget.alertId);
    if (mounted) Navigator.of(context).pop();
  }

  Future<void> _call(String digits) async {
    if (digits.isEmpty) return;
    await launchUrl(
      Uri.parse('tel:$digits'),
      mode: LaunchMode.externalApplication,
    );
  }

  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    return PopScope(
      onPopInvokedWithResult: (didPop, _) {
        if (didPop) _stopRinging();
      },
      child: Scaffold(
        backgroundColor: AppColors.background,
        body: SafeArea(
          child: ListenableBuilder(
            listenable: app.alerts,
            builder: (context, _) {
              final alert = app.alerts.byId(widget.alertId);
              if (alert == null) {
                return _Unknown(
                  busy: false,
                  onRetry: _refresh,
                  onDismiss: _dismiss,
                );
              }
              if (alert.isResolved) {
                return _AlreadyHandled(
                  student: alert.student.name,
                  room: alert.student.roomNumber,
                  onDismiss: _dismiss,
                );
              }

              final student = alert.student;
              final acknowledged = alert.isAcknowledged;
              return ListView(
                padding: const EdgeInsets.fromLTRB(20, 18, 20, 28),
                children: [
                  Row(
                    children: [
                      Container(
                        width: 54,
                        height: 54,
                        decoration: BoxDecoration(
                          color: AppColors.pending.withValues(alpha: 0.18),
                          shape: BoxShape.circle,
                        ),
                        child: const Icon(
                          Icons.emergency,
                          color: AppColors.pending,
                          size: 30,
                        ),
                      ),
                      const SizedBox(width: 14),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              acknowledged ? 'RESPONDING' : 'EMERGENCY ALERT',
                              style: TextStyle(
                                color: acknowledged
                                    ? AppColors.acknowledged
                                    : AppColors.pending,
                                fontSize: 12,
                                fontWeight: FontWeight.w800,
                                letterSpacing: 1.2,
                              ),
                            ),
                            const SizedBox(height: 3),
                            Text(
                              typeLabel(alert.type),
                              style: const TextStyle(
                                fontSize: 20,
                                fontWeight: FontWeight.w700,
                              ),
                            ),
                          ],
                        ),
                      ),
                      const ConnectionDot(compact: true),
                    ],
                  ),
                  const SizedBox(height: 24),
                  Container(
                    padding: const EdgeInsets.all(18),
                    decoration: BoxDecoration(
                      color: AppColors.surface,
                      borderRadius: BorderRadius.circular(18),
                      border: Border.all(
                        color: AppColors.pending.withValues(alpha: 0.45),
                      ),
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          student.name,
                          style: const TextStyle(
                            fontSize: 22,
                            fontWeight: FontWeight.w800,
                          ),
                        ),
                        const SizedBox(height: 4),
                        Text(
                          'Room ${student.roomNumber}',
                          style: const TextStyle(
                            color: AppColors.muted,
                            fontSize: 15,
                          ),
                        ),
                        const SizedBox(height: 14),
                        Wrap(
                          spacing: 8,
                          runSpacing: 8,
                          children: [
                            Tag(
                              text:
                                  '${timeHms(alert.createdAt)} · ${elapsedSince(alert.createdAt)}',
                              icon: Icons.schedule,
                            ),
                            if (alert.hasLocation)
                              Tag(
                                text: coordLabel(
                                  alert.latitude,
                                  alert.longitude,
                                ),
                                icon: Icons.place_outlined,
                              ),
                            if (alert.escalatedAt != null)
                              EscalationPill(escalatedAt: alert.escalatedAt),
                          ],
                        ),
                        if ((student.medicalConditions ?? '').isNotEmpty) ...[
                          const SizedBox(height: 14),
                          Text(
                            'Medical notes: ${student.medicalConditions}',
                            style: const TextStyle(
                              fontSize: 13,
                              color: AppColors.text,
                            ),
                          ),
                        ],
                      ],
                    ),
                  ),
                  const SizedBox(height: 14),
                  if (!acknowledged)
                    const Text(
                      'If no warden acknowledges, the server escalates to the '
                      'on-call phone by SMS after 60 seconds. Do not rely on '
                      'this app alone.',
                      style: TextStyle(color: AppColors.faint, fontSize: 12),
                    ),
                  const SizedBox(height: 20),
                  if (acknowledged)
                    Container(
                      padding: const EdgeInsets.all(14),
                      decoration: BoxDecoration(
                        color: AppColors.acknowledged.withValues(alpha: 0.12),
                        borderRadius: BorderRadius.circular(12),
                        border: Border.all(
                          color: AppColors.acknowledged.withValues(alpha: 0.4),
                        ),
                      ),
                      child: const Text(
                        'Acknowledged. You own this case until it is resolved.',
                        style: TextStyle(fontSize: 13),
                      ),
                    )
                  else
                    SizedBox(
                      height: 62,
                      child: FilledButton.icon(
                        style: FilledButton.styleFrom(
                          backgroundColor: AppColors.pending,
                          textStyle: const TextStyle(
                            fontSize: 18,
                            fontWeight: FontWeight.w800,
                          ),
                        ),
                        onPressed: _busy ? null : _acknowledge,
                        icon: _busy
                            ? const SizedBox(
                                width: 20,
                                height: 20,
                                child: CircularProgressIndicator(
                                  strokeWidth: 2,
                                  color: Colors.white,
                                ),
                              )
                            : const Icon(Icons.check_circle, size: 24),
                        label: Text(_busy ? 'Acknowledging…' : 'Acknowledge'),
                      ),
                    ),
                  const SizedBox(height: 10),
                  Row(
                    children: [
                      Expanded(
                        child: OutlinedButton.icon(
                          onPressed: () {
                            Navigator.of(context).push(
                              MaterialPageRoute<void>(
                                builder: (_) =>
                                    AlertDetailScreen(alertId: alert.id),
                              ),
                            );
                          },
                          icon: const Icon(Icons.open_in_new, size: 18),
                          label: const Text('Open case'),
                        ),
                      ),
                      const SizedBox(width: 10),
                      Expanded(
                        child: OutlinedButton.icon(
                          style: OutlinedButton.styleFrom(
                            foregroundColor: AppColors.muted,
                          ),
                          onPressed: _dismiss,
                          icon: const Icon(Icons.notifications_off_outlined,
                              size: 18),
                          label: const Text('Dismiss'),
                        ),
                      ),
                    ],
                  ),
                  if (student.contactDigits.isNotEmpty) ...[
                    const SizedBox(height: 10),
                    SizedBox(
                      height: 48,
                      child: OutlinedButton.icon(
                        onPressed: () => _call(student.contactDigits),
                        icon: const Icon(Icons.call, size: 18),
                        label: Text('Call ${student.emergencyContact}'),
                      ),
                    ),
                  ],
                ],
              );
            },
          ),
        ),
      ),
    );
  }
}

class _AlreadyHandled extends StatelessWidget {
  const _AlreadyHandled({
    required this.student,
    required this.room,
    required this.onDismiss,
  });

  final String student;
  final String room;
  final VoidCallback onDismiss;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(28),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(
              Icons.task_alt,
              size: 64,
              color: AppColors.resolved,
            ),
            const SizedBox(height: 16),
            const Text(
              'Already handled',
              style: TextStyle(fontSize: 22, fontWeight: FontWeight.w700),
            ),
            const SizedBox(height: 8),
            Text(
              '$student · Room $room was resolved before this screen opened.',
              textAlign: TextAlign.center,
              style: const TextStyle(color: AppColors.muted),
            ),
            const SizedBox(height: 24),
            FilledButton(onPressed: onDismiss, child: const Text('Close')),
          ],
        ),
      ),
    );
  }
}

class _Unknown extends StatelessWidget {
  const _Unknown({
    required this.busy,
    required this.onRetry,
    required this.onDismiss,
  });

  final bool busy;
  final Future<void> Function() onRetry;
  final VoidCallback onDismiss;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(28),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.sync_problem, size: 56, color: AppColors.muted),
            const SizedBox(height: 16),
            const Text(
              'Alert not in this device’s snapshot',
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700),
            ),
            const SizedBox(height: 8),
            const Text(
              'Connect to the server to fetch it. Dismissing does not '
              'acknowledge the alert — the SMS escalation still runs.',
              textAlign: TextAlign.center,
              style: TextStyle(color: AppColors.muted, fontSize: 12),
            ),
            const SizedBox(height: 20),
            FilledButton(
              onPressed: busy ? null : () => onRetry(),
              child: const Text('Retry'),
            ),
            TextButton(onPressed: onDismiss, child: const Text('Dismiss')),
          ],
        ),
      ),
    );
  }
}
