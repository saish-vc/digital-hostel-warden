import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:package_info_plus/package_info_plus.dart';

import '../config.dart';
import '../services/device_service.dart';
import '../services/formatting.dart';
import '../services/notifications.dart';
import '../services/push.dart';
import '../services/reliability.dart';
import '../services/socket.dart';
import '../state/app_scope.dart';
import '../theme.dart';
import '../widgets/indicators.dart';

class SettingsScreen extends StatefulWidget {
  const SettingsScreen({super.key});

  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  late Future<bool> _notificationsEnabled;
  bool _refreshing = false;
  bool _onDuty = false;
  bool _secureScreen = false;

  @override
  void initState() {
    super.initState();
    _notificationsEnabled = NotificationService.areNotificationsEnabled();
    Reliability.refreshBattery();
    _loadDevicePrefs();
  }

  Future<void> _loadDevicePrefs() async {
    final onDuty = await DevicePrefs.onDuty();
    final secure = await DevicePrefs.secureScreen();
    if (!mounted) return;
    setState(() {
      _onDuty = onDuty;
      _secureScreen = secure;
    });
  }

  Future<void> _toggleOnDuty(bool value) async {
    setState(() => _onDuty = value);
    await DevicePrefs.setOnDuty(value);
    await DeviceService.setOnDuty(value);
  }

  Future<void> _toggleSecure(bool value) async {
    setState(() => _secureScreen = value);
    await DevicePrefs.setSecureScreen(value);
    await DeviceService.setSecure(value);
  }

  void _recheck() {
    setState(() {
      _notificationsEnabled = NotificationService.areNotificationsEnabled();
    });
    PushService.instance.refreshPermission();
    Reliability.refreshBattery();
  }

  Future<void> _enableNotifications() async {
    final granted = await NotificationService.requestPermission();
    await PushService.instance.start();
    _recheck();
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(
          granted
              ? 'Notifications allowed. Send a test below.'
              : 'Still blocked. Open Android Settings › Apps › HostelGuard Warden › '
                  'Notifications to allow them.',
        ),
      ),
    );
  }

  Future<void> _refreshAll() async {
    final app = AppScope.read(context);
    setState(() => _refreshing = true);
    await app.reloadAll();
    if (!mounted) return;
    setState(() => _refreshing = false);
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('Alert board and leave desk refreshed.')),
    );
  }

  Future<void> _logout() async {
    final app = AppScope.read(context);
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Sign out?'),
        content: const Text(
          'This device stops receiving push alerts until a warden signs in again.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: AppColors.pending),
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: const Text('Sign out'),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    await app.logout();
  }

  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    final user = app.user;

    return Scaffold(
      appBar: AppBar(
        title: const Text(
          'Settings',
          style: TextStyle(fontWeight: FontWeight.w700),
        ),
        actions: const [
          Padding(
            padding: EdgeInsets.only(right: 14),
            child: Center(child: ConnectionDot()),
          ),
        ],
      ),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 28),
        children: [
          Container(
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(
              color: AppColors.surface,
              borderRadius: BorderRadius.circular(14),
              border: Border.all(color: AppColors.border),
            ),
            child: Row(
              children: [
                CircleAvatar(
                  radius: 23,
                  backgroundColor: AppColors.accent.withValues(alpha: 0.16),
                  child: Text(
                    initials(user?.name ?? 'Warden'),
                    style: const TextStyle(
                      color: AppColors.accent,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        (user?.name ?? '').isEmpty ? 'Warden' : user!.name,
                        style: const TextStyle(
                          fontSize: 16,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        '${user?.role ?? 'WARDEN'} · signed in',
                        style: const TextStyle(
                          color: AppColors.muted,
                          fontSize: 12,
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 14),
          _Section(
            title: 'PUSH NOTIFICATIONS',
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                ValueListenableBuilder<PushPermissionState>(
                  valueListenable: PushService.instance.permission,
                  builder: (context, state, _) {
                    return Column(
                      children: [
                        _StatusRow(
                          label: 'Firebase permission',
                          value: switch (state) {
                            PushPermissionState.granted => 'Granted',
                            PushPermissionState.denied => 'Blocked',
                            PushPermissionState.unsupported => 'Unavailable',
                            PushPermissionState.unknown => 'Not asked yet',
                          },
                          ok: state == PushPermissionState.granted,
                        ),
                        FutureBuilder<bool>(
                          future: _notificationsEnabled,
                          builder: (context, snapshot) {
                            final enabled = snapshot.data;
                            return _StatusRow(
                              label: 'Android notifications',
                              value: enabled == null
                                  ? 'Checking…'
                                  : enabled
                                      ? 'Allowed'
                                      : 'Blocked',
                              ok: enabled == true,
                            );
                          },
                        ),
                        _StatusRow(
                          label: 'Server registration',
                          value: app.pushRegistered ? 'Registered' : 'Pending',
                          ok: app.pushRegistered,
                        ),
                        const _StatusRow(
                          label: 'Channel',
                          value: '${NotificationService.channelId} · max',
                          ok: true,
                        ),
                      ],
                    );
                  },
                ),
                const SizedBox(height: 8),
                Row(
                  children: [
                    Expanded(
                      child: OutlinedButton.icon(
                        onPressed: _enableNotifications,
                        icon: const Icon(Icons.notifications_active_outlined, size: 18),
                        label: const Text('Enable'),
                      ),
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: OutlinedButton.icon(
                        onPressed: _recheck,
                        icon: const Icon(Icons.refresh, size: 18),
                        label: const Text('Re-check'),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 8),
                SizedBox(
                  width: double.infinity,
                  child: FilledButton.tonalIcon(
                    onPressed: () async {
                      await NotificationService.showTest();
                      if (!context.mounted) return;
                      ScaffoldMessenger.of(context).showSnackBar(
                        const SnackBar(
                          content: Text('Test notification sent to the tray.'),
                        ),
                      );
                    },
                    icon: const Icon(Icons.campaign_outlined, size: 18),
                    label: const Text('Send test notification'),
                  ),
                ),
                const SizedBox(height: 8),
                const Text(
                  'Alerts also arrive through the live socket while the app is '
                  'open. If Android blocks notifications, the in-app board still '
                  'updates.',
                  style: TextStyle(color: AppColors.faint, fontSize: 11),
                ),
              ],
            ),
          ),
          const SizedBox(height: 14),
          _Section(
            title: 'DELIVERY RELIABILITY',
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                ValueListenableBuilder<bool?>(
                  valueListenable: Reliability.batteryOptimized,
                  builder: (context, optimized, _) => _StatusRow(
                    label: 'Battery optimisation',
                    value: optimized == null
                        ? 'Unknown'
                        : optimized
                            ? 'On — Android may delay alerts'
                            : 'Unrestricted',
                    ok: optimized == false,
                  ),
                ),
                SwitchListTile(
                  contentPadding: EdgeInsets.zero,
                  dense: true,
                  value: _onDuty,
                  onChanged: _toggleOnDuty,
                  title: const Text(
                    'On-duty mode',
                    style: TextStyle(fontSize: 13),
                  ),
                  subtitle: const Text(
                    'Keeps the live socket in a foreground service while this '
                    'phone is on duty.',
                    style: TextStyle(fontSize: 11, color: AppColors.faint),
                  ),
                ),
                SwitchListTile(
                  contentPadding: EdgeInsets.zero,
                  dense: true,
                  value: _secureScreen,
                  onChanged: _toggleSecure,
                  title: const Text(
                    'Hide screen in recents',
                    style: TextStyle(fontSize: 13),
                  ),
                  subtitle: const Text(
                    'Blocks screenshots and the task-switcher preview of '
                    'student medical data.',
                    style: TextStyle(fontSize: 11, color: AppColors.faint),
                  ),
                ),
                const SizedBox(height: 6),
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    OutlinedButton(
                      onPressed: Reliability.requestBatteryExemption,
                      child: const Text('Battery exemption'),
                    ),
                    OutlinedButton(
                      onPressed: Reliability.openAppNotificationSettings,
                      child: const Text('App settings'),
                    ),
                    OutlinedButton(
                      onPressed: Reliability.openChannelSettings,
                      child: const Text('Alert channel'),
                    ),
                    OutlinedButton(
                      onPressed: Reliability.openDndAccess,
                      child: const Text('Do Not Disturb'),
                    ),
                    OutlinedButton(
                      onPressed: Reliability.openFullScreenIntentSettings,
                      child: const Text('Full-screen alerts'),
                    ),
                  ],
                ),
                const SizedBox(height: 8),
                const Text(
                  'The SMS escalation is server-side and still runs if this '
                  'phone is offline or muted.',
                  style: TextStyle(color: AppColors.faint, fontSize: 11),
                ),
              ],
            ),
          ),
          const SizedBox(height: 14),
          _Section(
            title: 'CONNECTION',
            child: Column(
              children: [
                ValueListenableBuilder<SocketStatus>(
                  valueListenable: SocketService.instance.status,
                  builder: (context, status, _) {
                    return _StatusRow(
                      label: 'Live socket',
                      value: switch (status) {
                        SocketStatus.connected => 'Connected',
                        SocketStatus.connecting => 'Connecting',
                        SocketStatus.disconnected => 'Offline',
                      },
                      ok: status == SocketStatus.connected,
                    );
                  },
                ),
                _StatusRow(
                  label: 'Server',
                  value: AppConfig.apiBase,
                  ok: true,
                  wrap: true,
                ),
                _StatusRow(
                  label: 'Board synced',
                  value: timeHms(app.alerts.lastUpdated),
                  ok: app.alerts.lastUpdated != null,
                ),
                _StatusRow(
                  label: 'Leaves synced',
                  value: timeHms(app.leaves.lastUpdated),
                  ok: app.leaves.lastUpdated != null,
                ),
              ],
            ),
          ),
          const SizedBox(height: 14),
          _Section(
            title: 'APP',
            child: FutureBuilder<PackageInfo>(
              future: PackageInfo.fromPlatform(),
              builder: (context, snapshot) {
                final info = snapshot.data;
                return Column(
                  children: [
                    _StatusRow(
                      label: 'Version',
                      value: info == null
                          ? AppConfig.version
                          : '${info.version} (${info.buildNumber})',
                      ok: true,
                    ),
                    _StatusRow(
                      label: 'Package',
                      value: info?.packageName ?? 'com.hostelguard.warden',
                      ok: true,
                      wrap: true,
                    ),
                    _StatusRow(
                      label: 'Build',
                      value: kReleaseMode
                          ? 'Release'
                          : kProfileMode
                              ? 'Profile'
                              : 'Debug',
                      ok: true,
                    ),
                  ],
                );
              },
            ),
          ),
          const SizedBox(height: 16),
          SizedBox(
            width: double.infinity,
            child: OutlinedButton.icon(
              onPressed: _refreshing ? null : _refreshAll,
              icon: _refreshing
                  ? const SizedBox(
                      width: 16,
                      height: 16,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.sync, size: 18),
              label: Text(_refreshing ? 'Refreshing…' : 'Refresh all data'),
            ),
          ),
          const SizedBox(height: 8),
          SizedBox(
            width: double.infinity,
            child: OutlinedButton.icon(
              onPressed: _logout,
              style: OutlinedButton.styleFrom(
                foregroundColor: AppColors.pending,
                side: BorderSide(color: AppColors.pending.withValues(alpha: 0.5)),
              ),
              icon: const Icon(Icons.logout, size: 18),
              label: const Text('Sign out'),
            ),
          ),
          const SizedBox(height: 18),
          const Text(
            'HostelGuard Warden · Android\n'
            'Emergency alerts via Firebase Cloud Messaging\n'
            'Maps © OpenStreetMap contributors',
            textAlign: TextAlign.center,
            style: TextStyle(color: AppColors.faint, fontSize: 11, height: 1.5),
          ),
        ],
      ),
    );
  }
}

class _Section extends StatelessWidget {
  const _Section({required this.title, required this.child});

  final String title;
  final Widget child;

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
          Text(
            title,
            style: const TextStyle(
              color: AppColors.faint,
              fontSize: 10,
              fontWeight: FontWeight.w700,
              letterSpacing: 0.8,
            ),
          ),
          const SizedBox(height: 10),
          child,
        ],
      ),
    );
  }
}

class _StatusRow extends StatelessWidget {
  const _StatusRow({
    required this.label,
    required this.value,
    required this.ok,
    this.wrap = false,
  });

  final String label;
  final String value;
  final bool ok;
  final bool wrap;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 132,
            child: Text(
              label,
              style: const TextStyle(color: AppColors.muted, fontSize: 12),
            ),
          ),
          Expanded(
            child: Text(
              value,
              textAlign: wrap ? TextAlign.start : TextAlign.end,
              style: TextStyle(
                color: ok ? AppColors.text : AppColors.pending,
                fontSize: 12,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
