import 'package:flutter/material.dart';

import '../services/api.dart';
import '../services/socket.dart';

class ConfirmationScreen extends StatefulWidget {
  const ConfirmationScreen({super.key, required this.alert});

  final Map<String, dynamic> alert;

  @override
  State<ConfirmationScreen> createState() => _ConfirmationScreenState();
}

class _ConfirmationScreenState extends State<ConfirmationScreen> {
  bool _acknowledged = false;
  bool _resolved = false;
  DateTime? _acknowledgedAt;
  DateTime? _resolvedAt;

  String get _alertId => widget.alert['id'] as String;

  @override
  void initState() {
    super.initState();
    final status = widget.alert['status'];
    // An alert opened from history can already be RESOLVED; more often the
    // student arrives here straight from SOS, so both states are handled.
    _acknowledged = status == 'ACKNOWLEDGED' || status == 'RESOLVED';
    _resolved = status == 'RESOLVED';
    _connectSocket();
  }

  Future<void> _connectSocket() async {
    final token = await ApiService.token;
    if (token == null || !mounted) return;

    SocketService.instance.connect(
      token,
      onAlertUpdated: (alert) {
        if (!mounted) return;
        if (alert['id'] != _alertId) return;

        final status = alert['status'];
        // ACKNOWLEDGED -> "help is coming"; RESOLVED -> "case closed".
        if (status != 'ACKNOWLEDGED' && status != 'RESOLVED') return;

        setState(() {
          _acknowledged = true;
          _resolved = status == 'RESOLVED';

          final acknowledgedAt = alert['acknowledgedAt'];
          _acknowledgedAt =
              acknowledgedAt is String ? DateTime.tryParse(acknowledgedAt) : null;

          final resolvedAt = alert['resolvedAt'];
          _resolvedAt = resolvedAt is String ? DateTime.tryParse(resolvedAt) : null;
        });
      },
    );
  }

  @override
  void dispose() {
    SocketService.instance.disconnect();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final type = widget.alert['type'] ?? 'Emergency';

    final String title = _resolved
        ? 'Case closed ✅'
        : _acknowledged
            ? 'Warden acknowledged'
            : 'Alert sent. Waiting for a warden...';

    final String body = _resolved
        ? 'The warden has resolved your $type alert. Stay safe — call the desk again if you need help.'
        : _acknowledged
            ? 'Help is on the way. Stay where you are if it is safe.'
            : 'Your $type alert has reached the warden desk.';

    final Color titleColor = _resolved
        ? Colors.greenAccent
        : _acknowledged
            ? Colors.greenAccent
            : Colors.white;

    return Scaffold(
      backgroundColor: const Color(0xFF0B1120),
      body: SafeArea(
        child: Center(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                AnimatedSwitcher(
                  duration: const Duration(milliseconds: 350),
                  child: _resolved
                      ? const Icon(
                          Icons.check_circle,
                          key: ValueKey('resolved'),
                          size: 96,
                          color: Colors.greenAccent,
                        )
                      : _acknowledged
                          ? const Icon(
                              Icons.verified,
                              key: ValueKey('ok'),
                              size: 96,
                              color: Colors.greenAccent,
                            )
                          : const SizedBox(
                              key: ValueKey('waiting'),
                              height: 96,
                              width: 96,
                              child: CircularProgressIndicator(
                                strokeWidth: 4,
                                color: Colors.redAccent,
                              ),
                            ),
                ),
                const SizedBox(height: 32),
                Text(
                  title,
                  textAlign: TextAlign.center,
                  style: TextStyle(
                    color: titleColor,
                    fontSize: 26,
                    fontWeight: FontWeight.bold,
                  ),
                ),
                const SizedBox(height: 12),
                Text(
                  body,
                  textAlign: TextAlign.center,
                  style: const TextStyle(color: Colors.white70, fontSize: 15),
                ),
                if (_acknowledgedAt != null) ...[
                  const SizedBox(height: 8),
                  Text(
                    'Acknowledged at ${_acknowledgedAt!.toLocal()}',
                    style: const TextStyle(color: Colors.white38, fontSize: 12),
                  ),
                ],
                if (_resolvedAt != null) ...[
                  const SizedBox(height: 4),
                  Text(
                    'Resolved at ${_resolvedAt!.toLocal()}',
                    style: const TextStyle(color: Colors.white38, fontSize: 12),
                  ),
                ],
                const SizedBox(height: 40),
                if (_acknowledged)
                  FilledButton.icon(
                    onPressed: () => Navigator.of(context).pop(),
                    icon: const Icon(Icons.home),
                    label: const Text('Back to home'),
                    style: FilledButton.styleFrom(
                      backgroundColor: Colors.green.shade700,
                      padding: const EdgeInsets.symmetric(
                        horizontal: 24,
                        vertical: 14,
                      ),
                    ),
                  ),
                const SizedBox(height: 32),
                const Text(
                  'If you can, call the warden desk directly as well.',
                  textAlign: TextAlign.center,
                  style: TextStyle(color: Colors.white38, fontSize: 12),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
