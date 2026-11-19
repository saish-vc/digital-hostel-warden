import 'package:flutter/material.dart';
import 'package:qr_flutter/qr_flutter.dart';

import '../services/api.dart';
import '../services/location.dart';

/// High-contrast gate pass for the security desk, plus the off-campus SOS.
///
/// The pass is fetched fresh from `GET /leaves/:id/pass` every time this
/// screen opens: the warden may have already marked departure, and a cached
/// "APPROVED" would show the wrong instructions at the gate.
class GatePassScreen extends StatefulWidget {
  const GatePassScreen({super.key, required this.leaveId});

  final String leaveId;

  @override
  State<GatePassScreen> createState() => _GatePassScreenState();
}

class _GatePassScreenState extends State<GatePassScreen> {
  bool _loading = true;
  bool _sendingSos = false;
  String? _error;
  Map<String, dynamic>? _pass;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });

    try {
      final pass = await ApiService.leavePass(widget.leaveId);
      if (!mounted) return;
      setState(() {
        _pass = pass;
        _loading = false;
      });
    } on ApiException catch (error) {
      if (!mounted) return;
      setState(() {
        _error = error.message;
        _loading = false;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _error = 'Could not reach the hostel server.';
        _loading = false;
      });
    }
  }

  Future<void> _sendOffCampusSos() async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        backgroundColor: const Color(0xFF111827),
        title: const Text('Send off-campus SOS?', style: TextStyle(color: Colors.white)),
        content: const Text(
          'The warden will be alerted immediately with your last known location. '
          'If you do not get a response, the escalation to the head warden fires '
          'after 60 seconds — exactly like the SOS button on the home screen.',
          style: TextStyle(color: Colors.white70),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: const Text('Not now'),
          ),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: Colors.red.shade700),
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: const Text('Send SOS'),
          ),
        ],
      ),
    );

    if (confirmed != true || !mounted) return;

    setState(() => _sendingSos = true);

    // Same rule as the on-campus button: a GPS failure must never block it.
    final fix = await getCurrentLocationSafe();

    try {
      await ApiService.leaveEmergency(
        widget.leaveId,
        latitude: fix?.lat,
        longitude: fix?.lng,
        locationAccuracy: fix?.accuracy,
      );

      if (!mounted) return;
      await showDialog<void>(
        context: context,
        builder: (dialogContext) => AlertDialog(
          backgroundColor: const Color(0xFF111827),
          title: const Text('Warden alerted', style: TextStyle(color: Colors.white)),
          content: Text(
            fix == null
                ? 'Your SOS was sent without GPS. Stay where you are and keep '
                    'your phone reachable.'
                : 'Your SOS was sent with your location. Stay where you are and '
                    'keep your phone reachable.',
            style: const TextStyle(color: Colors.white70),
          ),
          actions: [
            FilledButton(
              onPressed: () => Navigator.of(dialogContext).pop(),
              child: const Text('OK'),
            ),
          ],
        ),
      );
    } on ApiException catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(error.message), backgroundColor: Colors.red.shade800),
      );
    } catch (_) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Could not send the SOS. Call the warden desk.'),
          backgroundColor: Colors.red,
        ),
      );
    } finally {
      if (mounted) setState(() => _sendingSos = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFF0B1120),
      appBar: AppBar(
        backgroundColor: Colors.transparent,
        elevation: 0,
        title: const Text('Gate pass'),
        actions: [
          IconButton(
            onPressed: _loading ? null : _load,
            icon: const Icon(Icons.refresh),
            tooltip: 'Refresh',
          ),
        ],
      ),
      body: SafeArea(child: _body()),
    );
  }

  Widget _body() {
    if (_loading) {
      return const Center(child: CircularProgressIndicator(color: Colors.redAccent));
    }

    if (_error != null || _pass == null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.qr_code_2, size: 48, color: Colors.white38),
              const SizedBox(height: 12),
              Text(
                _error ?? 'Gate pass unavailable.',
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

    final pass = _pass!;
    final code = pass['gatePassCode'] as String? ?? '—';
    final status = pass['status'] as String? ?? 'APPROVED';
    final qrData = pass['gatePassQr'] as String? ?? code;
    final departed = status == 'DEPARTED';

    return ListView(
      padding: const EdgeInsets.fromLTRB(20, 8, 20, 32),
      children: [
        Container(
          padding: const EdgeInsets.all(20),
          decoration: BoxDecoration(
            color: Colors.white,
            borderRadius: BorderRadius.circular(24),
          ),
          child: Column(
            children: [
              Text(
                'HOSTEL GATE PASS',
                style: TextStyle(
                  color: Colors.grey.shade800,
                  fontSize: 13,
                  fontWeight: FontWeight.w800,
                  letterSpacing: 2,
                ),
              ),
              const SizedBox(height: 12),
              // White background + black modules: the security desk scans this
              // from a phone screen in daylight, not in this app's dark theme.
              QrImageView(
                data: qrData,
                version: QrVersions.auto,
                size: 220,
                backgroundColor: Colors.white,
                eyeStyle: const QrEyeStyle(
                  eyeShape: QrEyeShape.square,
                  color: Colors.black,
                ),
                dataModuleStyle: const QrDataModuleStyle(
                  dataModuleShape: QrDataModuleShape.square,
                  color: Colors.black,
                ),
              ),
              const SizedBox(height: 12),
              Text(
                code,
                style: const TextStyle(
                  color: Colors.black,
                  fontSize: 30,
                  fontWeight: FontWeight.w900,
                  letterSpacing: 3,
                ),
              ),
              const SizedBox(height: 4),
              Text(
                departed ? 'Gate pass used — you are marked away' : 'Show this to the security desk',
                textAlign: TextAlign.center,
                style: TextStyle(color: Colors.grey.shade700, fontSize: 13),
              ),
            ],
          ),
        ),
        const SizedBox(height: 20),
        _detail('Student', '${pass['studentName'] ?? ''} · Room ${pass['studentRoom'] ?? ''}'),
        _detail('Destination', pass['destination'] as String? ?? '—'),
        _detail('Status', _statusLabel(status)),
        _detail('Departure', _format(pass['departureTime'])),
        _detail('Expected return', _format(pass['expectedReturn'])),
        if (pass['actualDeparture'] != null)
          _detail('Left the gate', _format(pass['actualDeparture'])),
        const SizedBox(height: 24),
        FilledButton.icon(
          onPressed: _sendingSos ? null : _sendOffCampusSos,
          style: FilledButton.styleFrom(
            backgroundColor: Colors.red.shade700,
            foregroundColor: Colors.white,
            minimumSize: const Size.fromHeight(56),
          ),
          icon: _sendingSos
              ? const SizedBox(
                  width: 18,
                  height: 18,
                  child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                )
              : const Icon(Icons.sos),
          label: Text(_sendingSos ? 'Sending SOS…' : 'Off-campus SOS'),
        ),
        const SizedBox(height: 10),
        const Text(
          'Use this only while you are outside the hostel. It alerts the warden '
          'with your location and starts the same 60-second escalation.',
          textAlign: TextAlign.center,
          style: TextStyle(color: Colors.white38, fontSize: 12),
        ),
      ],
    );
  }

  Widget _detail(String label, String value) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 130,
            child: Text(label, style: const TextStyle(color: Colors.white54, fontSize: 13)),
          ),
          Expanded(
            child: Text(value, style: const TextStyle(color: Colors.white, fontSize: 14)),
          ),
        ],
      ),
    );
  }

  static String _statusLabel(String status) => switch (status) {
        'APPROVED' => 'Approved — not yet left',
        'DEPARTED' => 'Away from the hostel',
        _ => status,
      };

  static const _months = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];

  static String _format(dynamic raw) {
    if (raw is! String || raw.isEmpty) return '—';
    final parsed = DateTime.tryParse(raw)?.toLocal();
    if (parsed == null) return raw;
    final hour = parsed.hour.toString().padLeft(2, '0');
    final minute = parsed.minute.toString().padLeft(2, '0');
    return '${parsed.day} ${_months[parsed.month - 1]} ${parsed.year}, $hour:$minute';
  }
}
