import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../models/alert.dart';
import '../services/formatting.dart';
import '../state/app_scope.dart';
import '../theme.dart';
import '../widgets/alert_map.dart';
import '../widgets/common.dart';
import '../widgets/indicators.dart';

class AlertDetailScreen extends StatelessWidget {
  const AlertDetailScreen({super.key, required this.alertId});

  final String alertId;

  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    final alert = app.alerts.byId(alertId);
    return Scaffold(
      appBar: AppBar(
        title: Text(alert == null ? 'Alert' : alert.student.name),
        actions: const [
          Padding(
            padding: EdgeInsets.only(right: 14),
            child: Center(child: ConnectionDot()),
          ),
        ],
      ),
      body: alert == null
          ? EmptyState(
              icon: Icons.search_off,
              title: 'Alert not available',
              subtitle: 'It may have been removed from this device’s snapshot.',
              // ignore: use_build_context_synchronously
            )
          : AlertDetailView(alert: alert),
    );
  }
}

class AlertDetailView extends StatefulWidget {
  const AlertDetailView({super.key, required this.alert});

  final Alert alert;

  @override
  State<AlertDetailView> createState() => _AlertDetailViewState();
}

class _AlertDetailViewState extends State<AlertDetailView> {
  bool _busy = false;

  Future<void> _acknowledge() async {
    final app = AppScope.read(context);
    setState(() => _busy = true);
    final ok = await app.alerts.acknowledge(widget.alert.id);
    if (!mounted) return;
    setState(() => _busy = false);
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(ok
            ? 'Alert acknowledged.'
            : app.alerts.error ?? 'Could not acknowledge the alert.'),
      ),
    );
  }

  Future<void> _resolve() async {
    final app = AppScope.read(context);
    final note = await _askForNote();
    if (note == null || !mounted) return;
    setState(() => _busy = true);
    final ok = await app.alerts.resolve(widget.alert.id, note);
    if (!mounted) return;
    setState(() => _busy = false);
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(ok
            ? 'Case resolved.'
            : app.alerts.error ?? 'Could not resolve the alert.'),
      ),
    );
  }

  Future<String?> _askForNote() async {
    final controller = TextEditingController();
    final result = await showDialog<String>(
      context: context,
      builder: (dialogContext) {
        return StatefulBuilder(
          builder: (context, setDialogState) {
            final text = controller.text.trim();
            final valid = text.length >= 3 && text.length <= 500;
            return AlertDialog(
              title: const Text('Resolve alert'),
              content: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text(
                    'Record what was done. The student and the history log see this note.',
                    style: TextStyle(color: AppColors.muted, fontSize: 13),
                  ),
                  const SizedBox(height: 12),
                  TextField(
                    controller: controller,
                    autofocus: true,
                    maxLength: 500,
                    maxLines: 3,
                    minLines: 2,
                    onChanged: (_) => setDialogState(() {}),
                    decoration: const InputDecoration(
                      hintText: 'e.g. Sent to campus clinic, warden on site',
                    ),
                  ),
                  Text(
                    valid
                        ? '${text.length}/500'
                        : 'Enter at least 3 characters (3–500).',
                    style: TextStyle(
                      fontSize: 11,
                      color: valid ? AppColors.faint : AppColors.acknowledged,
                    ),
                  ),
                ],
              ),
              actions: [
                TextButton(
                  onPressed: () => Navigator.of(dialogContext).pop(),
                  child: const Text('Cancel'),
                ),
                FilledButton(
                  onPressed: valid
                      ? () => Navigator.of(dialogContext).pop(text)
                      : null,
                  child: const Text('Resolve'),
                ),
              ],
            );
          },
        );
      },
    );
    controller.dispose();
    return result;
  }

  Future<void> _call(String digits) async {
    if (digits.isEmpty) return;
    final uri = Uri.parse('tel:$digits');
    final launched = await launchUrl(uri, mode: LaunchMode.externalApplication);
    if (!launched && mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('No dialler available on this device.')),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    final alert = app.alerts.byId(widget.alert.id) ?? widget.alert;
    final student = alert.student;
    final canAcknowledge = alert.isPending;
    final canResolve = alert.isAcknowledged;

    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
      children: [
        if (app.alerts.error != null) ...[
          ErrorBanner(message: app.alerts.error!),
          const SizedBox(height: 12),
        ],
        Container(
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(
            color: AppColors.surface,
            borderRadius: BorderRadius.circular(16),
            border: Border.all(color: statusColor(alert.status).withValues(alpha: 0.35)),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Container(
                    width: 42,
                    height: 42,
                    decoration: BoxDecoration(
                      color: statusColor(alert.status).withValues(alpha: 0.15),
                      borderRadius: BorderRadius.circular(12),
                    ),
                    child: Icon(
                      Icons.emergency_outlined,
                      color: statusColor(alert.status),
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          student.name,
                          style: const TextStyle(
                            fontSize: 18,
                            fontWeight: FontWeight.w700,
                          ),
                        ),
                        Text(
                          'Room ${student.roomNumber} · ${typeLabel(alert.type)}',
                          style: const TextStyle(
                            color: AppColors.muted,
                            fontSize: 13,
                          ),
                        ),
                      ],
                    ),
                  ),
                  StatusPill(status: alert.status),
                ],
              ),
              const SizedBox(height: 12),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  Tag(
                    text: '${timeHms(alert.createdAt)} · ${elapsedSince(alert.createdAt)}',
                    icon: Icons.schedule,
                  ),
                  if (alert.hasLocation)
                    Tag(
                      text: 'GPS ±${(alert.locationAccuracy ?? 0).round()} m',
                      icon: Icons.gps_fixed,
                    ),
                  if (alert.escalatedAt != null)
                    EscalationPill(escalatedAt: alert.escalatedAt),
                ],
              ),
              if (alert.offCampusLeave != null) ...[
                const SizedBox(height: 12),
                Container(
                  width: double.infinity,
                  padding: const EdgeInsets.all(10),
                  decoration: BoxDecoration(
                    color: AppColors.info.withValues(alpha: 0.1),
                    borderRadius: BorderRadius.circular(10),
                    border: Border.all(color: AppColors.info.withValues(alpha: 0.3)),
                  ),
                  child: Text(
                    'Raised from an approved leave · ${alert.offCampusLeave!.destination}'
                    '${alert.offCampusLeave!.expectedReturn == null ? '' : ' · due back ${dayMonth(alert.offCampusLeave!.expectedReturn)}'}',
                    style: const TextStyle(fontSize: 12, color: AppColors.text),
                  ),
                ),
              ],
              const SizedBox(height: 16),
              Row(
                children: [
                  if (canAcknowledge)
                    Expanded(
                      child: FilledButton.icon(
                        onPressed: _busy ? null : _acknowledge,
                        icon: _busy
                            ? const SizedBox(
                                width: 16,
                                height: 16,
                                child: CircularProgressIndicator(strokeWidth: 2),
                              )
                            : const Icon(Icons.check_circle_outline, size: 18),
                        label: Text(_busy ? 'Acknowledging…' : 'Acknowledge'),
                      ),
                    ),
                  if (canResolve)
                    Expanded(
                      child: FilledButton.icon(
                        style: FilledButton.styleFrom(
                          backgroundColor: AppColors.resolved,
                        ),
                        onPressed: _busy ? null : _resolve,
                        icon: const Icon(Icons.task_alt, size: 18),
                        label: Text(_busy ? 'Resolving…' : 'Resolve'),
                      ),
                    ),
                  if (!canAcknowledge && !canResolve)
                    Expanded(
                      child: Container(
                        padding: const EdgeInsets.symmetric(vertical: 12),
                        alignment: Alignment.center,
                        decoration: BoxDecoration(
                          color: AppColors.surfaceHigh,
                          borderRadius: BorderRadius.circular(12),
                        ),
                        child: Text(
                          alert.isResolved
                              ? 'Resolved ${dateMedium(alert.resolvedAt)}'
                              : 'No action available',
                          style: const TextStyle(
                            color: AppColors.muted,
                            fontSize: 12,
                          ),
                        ),
                      ),
                    ),
                ],
              ),
            ],
          ),
        ),
        const SizedBox(height: 14),
        if (alert.hasLocation) ...[
          AlertMap(
            latitude: alert.latitude!,
            longitude: alert.longitude!,
            accuracy: alert.locationAccuracy,
          ),
          const SizedBox(height: 8),
          Row(
            children: [
              const Icon(Icons.place_outlined, size: 15, color: AppColors.muted),
              const SizedBox(width: 6),
              Expanded(
                child: Text(
                  coordLabel(alert.latitude, alert.longitude),
                  style: const TextStyle(
                    color: AppColors.muted,
                    fontSize: 12,
                    fontFeatures: [FontFeature.tabularFigures()],
                  ),
                ),
              ),
              if ((alert.locationAccuracy ?? 0) > 0)
                Text(
                  accuracyLabel(alert.locationAccuracy),
                  style: const TextStyle(color: AppColors.faint, fontSize: 11),
                ),
            ],
          ),
        ] else
          Container(
            padding: const EdgeInsets.all(16),
            decoration: BoxDecoration(
              color: AppColors.surface,
              borderRadius: BorderRadius.circular(14),
              border: Border.all(color: AppColors.border),
            ),
            child: const Row(
              children: [
                Icon(Icons.location_off_outlined, color: AppColors.faint),
                SizedBox(width: 10),
                Expanded(
                  child: Text(
                    'Location unavailable — the student device did not send GPS.',
                    style: TextStyle(color: AppColors.muted, fontSize: 12),
                  ),
                ),
              ],
            ),
          ),
        const SizedBox(height: 14),
        _InfoCard(
          rows: [
            ('Created', dateMedium(alert.createdAt)),
            ('Acknowledged', dateMedium(alert.acknowledgedAt)),
            ('Resolved', dateMedium(alert.resolvedAt)),
            if ((alert.resolutionNote ?? '').isNotEmpty)
              ('Resolution note', alert.resolutionNote!),
            if ((student.medicalConditions ?? '').isNotEmpty)
              ('Medical notes', student.medicalConditions!),
          ],
        ),
        const SizedBox(height: 14),
        Container(
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(
            color: AppColors.surface,
            borderRadius: BorderRadius.circular(14),
            border: Border.all(color: AppColors.border),
          ),
          child: Row(
            children: [
              const Icon(Icons.contact_phone_outlined, color: AppColors.muted),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text(
                      'Emergency contact',
                      style: TextStyle(color: AppColors.faint, fontSize: 11),
                    ),
                    Text(
                      student.emergencyContact.isEmpty
                          ? 'Not provided'
                          : student.emergencyContact,
                      style: const TextStyle(fontSize: 14),
                    ),
                  ],
                ),
              ),
              FilledButton.tonalIcon(
                onPressed: student.contactDigits.isEmpty
                    ? null
                    : () => _call(student.contactDigits),
                icon: const Icon(Icons.call, size: 18),
                label: const Text('Call'),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

class _InfoCard extends StatelessWidget {
  const _InfoCard({required this.rows});

  final List<(String, String)> rows;

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
        children: [
          for (var i = 0; i < rows.length; i++) ...[
            if (i > 0) const Divider(height: 18),
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                SizedBox(
                  width: 118,
                  child: Text(
                    rows[i].$1,
                    style: const TextStyle(color: AppColors.faint, fontSize: 12),
                  ),
                ),
                Expanded(
                  child: Text(
                    rows[i].$2,
                    style: const TextStyle(fontSize: 12),
                  ),
                ),
              ],
            ),
          ],
        ],
      ),
    );
  }
}
