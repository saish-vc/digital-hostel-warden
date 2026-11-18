import 'package:flutter/material.dart';
import 'package:geolocator/geolocator.dart';

import '../services/api.dart';
import '../services/location.dart';
import 'confirmation_screen.dart';
import 'login_screen.dart';

enum _LocationStatus { ready, locating, unavailable }

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  bool _sending = false;
  _LocationStatus _locationStatus = _LocationStatus.ready;
  String _selectedType = 'Medical';

  Future<void> _sendSos() async {
    setState(() {
      _sending = true;
      _locationStatus = _LocationStatus.locating;
    });

    // Never blocks the SOS: worst case this takes ~5 seconds and returns null.
    final fix = await getCurrentLocationSafe();

    if (!mounted) return;
    setState(() {
      _locationStatus =
          fix == null ? _LocationStatus.unavailable : _LocationStatus.ready;
    });

    try {
      final alert = await ApiService.createAlert(
        _selectedType,
        latitude: fix?.lat,
        longitude: fix?.lng,
        locationAccuracy: fix?.accuracy,
      );

      // The alert is already on its way; only now tell the student that
      // location has been permanently denied and can be fixed in Settings.
      if (fix == null) {
        final permission = await Geolocator.checkPermission();
        if (permission == LocationPermission.deniedForever && mounted) {
          await _showLocationSettingsDialog();
        }
      }

      if (!mounted) return;
      Navigator.of(context).push(
        MaterialPageRoute(builder: (_) => ConfirmationScreen(alert: alert)),
      );
    } on ApiException catch (error) {
      _showError(error.message);
    } catch (error) {
      _showError('Could not reach the hostel server. Call the warden desk.');
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  Future<void> _showLocationSettingsDialog() async {
    final shouldOpen = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        backgroundColor: const Color(0xFF111827),
        title: const Text(
          'Location permission is off',
          style: TextStyle(color: Colors.white),
        ),
        content: const Text(
          'Your location helps the warden find you faster, but it is not '
          'required to send an alert. You can enable it once in phone '
          'Settings and it will be shared only when you press SOS.',
          style: TextStyle(color: Colors.white70),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: const Text('Not now'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: const Text('Open settings'),
          ),
        ],
      ),
    );

    if (shouldOpen == true) {
      await Geolocator.openAppSettings();
    }
  }

  void _showError(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(message),
        backgroundColor: Colors.red.shade800,
      ),
    );
  }

  Future<void> _logout() async {
    await ApiService.logout();
    if (!mounted) return;
    Navigator.of(context).pushAndRemoveUntil(
      MaterialPageRoute(builder: (_) => const LoginScreen()),
      (_) => false,
    );
  }

  Widget _statusLine() {
    final (String text, Color color) = switch (_locationStatus) {
      _LocationStatus.locating => ('Locating…', Colors.amber),
      _LocationStatus.ready => ('Location ready', Colors.greenAccent),
      _LocationStatus.unavailable => ('Location unavailable', Colors.redAccent),
    };

    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(Icons.location_on, size: 16, color: color),
        const SizedBox(width: 4),
        Text(
          text,
          style: TextStyle(color: color, fontSize: 13),
        ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFF0B1120),
      appBar: AppBar(
        backgroundColor: Colors.transparent,
        elevation: 0,
        title: const Text('Hostel SOS'),
        actions: [
          IconButton(
            onPressed: _logout,
            icon: const Icon(Icons.logout),
            tooltip: 'Log out',
          ),
        ],
      ),
      body: SafeArea(
        child: Center(
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 24),
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                const Text(
                  'Need help right now?',
                  style: TextStyle(
                    color: Colors.white,
                    fontSize: 24,
                    fontWeight: FontWeight.bold,
                  ),
                ),
                const SizedBox(height: 8),
                const Text(
                  'Press the button to alert the warden on duty.',
                  textAlign: TextAlign.center,
                  style: TextStyle(color: Colors.white70),
                ),
                const SizedBox(height: 24),
                Wrap(
                  spacing: 8,
                  alignment: WrapAlignment.center,
                  children: ['Medical', 'Fire', 'Security', 'Other'].map((type) {
                    final selected = _selectedType == type;
                    return ChoiceChip(
                      label: Text(type),
                      selected: selected,
                      onSelected: _sending
                          ? null
                          : (val) {
                              if (val) setState(() => _selectedType = type);
                            },
                      selectedColor: Colors.red.shade700,
                      backgroundColor: const Color(0xFF1E293B),
                      labelStyle: TextStyle(
                        color: selected ? Colors.white : Colors.white70,
                        fontWeight: selected ? FontWeight.bold : FontWeight.normal,
                      ),
                    );
                  }).toList(),
                ),
                const SizedBox(height: 32),
                GestureDetector(
                  onTap: _sending ? null : _sendSos,
                  child: AnimatedContainer(
                    duration: const Duration(milliseconds: 150),
                    width: 240,
                    height: 240,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      gradient: LinearGradient(
                        begin: Alignment.topLeft,
                        end: Alignment.bottomRight,
                        colors: _sending
                            ? [Colors.red.shade900, Colors.red.shade700]
                            : [Colors.red.shade400, Colors.red.shade700],
                      ),
                      boxShadow: [
                        BoxShadow(
                          color: Colors.red.withValues(alpha: 0.45),
                          blurRadius: 40,
                          spreadRadius: 6,
                        ),
                      ],
                    ),
                    child: Center(
                      child: _sending
                          ? const SizedBox(
                              height: 48,
                              width: 48,
                              child: CircularProgressIndicator(
                                strokeWidth: 3,
                                color: Colors.white,
                              ),
                            )
                          : Column(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                const Icon(Icons.sos, size: 72, color: Colors.white),
                                const SizedBox(height: 8),
                                const Text(
                                  'SOS',
                                  style: TextStyle(
                                    color: Colors.white,
                                    fontSize: 40,
                                    fontWeight: FontWeight.w900,
                                    letterSpacing: 2,
                                  ),
                                ),
                                Text(
                                  '$_selectedType emergency',
                                  style: const TextStyle(
                                    color: Colors.white70,
                                    fontSize: 13,
                                  ),
                                ),
                              ],
                            ),
                    ),
                  ),
                ),
                const SizedBox(height: 16),
                _statusLine(),
                const SizedBox(height: 40),
                const Text(
                  'A warden is notified immediately.',
                  style: TextStyle(color: Colors.white38, fontSize: 13),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
