import 'dart:async';

import 'package:flutter/material.dart';

import '../services/push.dart';
import '../services/reliability.dart';
import '../state/app_scope.dart';
import '../state/app_state.dart';
import '../theme.dart';
import 'alarm_screen.dart';
import 'alert_detail_screen.dart';
import 'board_screen.dart';
import 'history_screen.dart';
import 'leave_desk_screen.dart';
import 'settings_screen.dart';

class AppShell extends StatefulWidget {
  const AppShell({super.key});

  @override
  State<AppShell> createState() => _AppShellState();
}

class _AppShellState extends State<AppShell> with WidgetsBindingObserver {
  int _index = 0;
  bool _alarmOpen = false;
  late final AppState _app;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _app = AppScope.read(context);
    _app.pendingOpenAlert.addListener(_onPendingOpenAlert);
    _app.alarmAlertId.addListener(_onAlarmAlert);
    _app.alerts.escalationFailure.addListener(_onEscalationFailure);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _onPendingOpenAlert();
    });
  }

  @override
  void dispose() {
    _app.pendingOpenAlert.removeListener(_onPendingOpenAlert);
    _app.alarmAlertId.removeListener(_onAlarmAlert);
    _app.alerts.escalationFailure.removeListener(_onEscalationFailure);
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state != AppLifecycleState.resumed) return;
    // The socket reconnects on its own; a resume refetch closes the gap for
    // events that arrived while Android had the process frozen.
    unawaited(_app.reloadAll());
    unawaited(PushService.instance.refreshPermission());
    unawaited(Reliability.refreshBattery());
  }

  void _onAlarmAlert() {
    final id = _app.alarmAlertId.value;
    if (id == null || id.isEmpty || _alarmOpen) return;
    _app.alarmAlertId.value = null;
    _alarmOpen = true;
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      if (!mounted) return;
      await Navigator.of(context).push(
        MaterialPageRoute<void>(
          fullscreenDialog: true,
          builder: (_) => AlarmScreen(alertId: id),
        ),
      );
      _alarmOpen = false;
    });
  }

  void _onPendingOpenAlert() {
    final id = _app.pendingOpenAlert.value;
    if (id == null || id.isEmpty) return;
    _app.pendingOpenAlert.value = null;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) => AlertDetailScreen(alertId: id),
        ),
      );
    });
  }

  void _onEscalationFailure() {
    final message = _app.alerts.escalationFailure.value;
    if (message == null) return;
    _app.alerts.escalationFailure.value = null;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(message),
          duration: const Duration(seconds: 6),
          backgroundColor: AppColors.pending,
        ),
      );
    });
  }

  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    return Scaffold(
      body: IndexedStack(
        index: _index,
        children: const [
          BoardScreen(),
          LeaveDeskScreen(),
          HistoryScreen(),
          SettingsScreen(),
        ],
      ),
      bottomNavigationBar: ListenableBuilder(
        listenable: Listenable.merge([app.alerts, app.leaves]),
        builder: (context, _) {
          final pendingAlerts = app.alerts.pendingCount;
          final pendingLeaves = app.leaves.pending.length;
          return NavigationBar(
            selectedIndex: _index,
            onDestinationSelected: (value) {
              setState(() => _index = value);
              if (value == 1) app.leaves.markRequestsSeen();
            },
            destinations: [
              NavigationDestination(
                icon: Badge.count(
                  count: pendingAlerts,
                  isLabelVisible: pendingAlerts > 0,
                  child: const Icon(Icons.notifications_outlined),
                ),
                selectedIcon: Badge.count(
                  count: pendingAlerts,
                  isLabelVisible: pendingAlerts > 0,
                  child: const Icon(Icons.notifications),
                ),
                label: 'Alerts',
              ),
              NavigationDestination(
                icon: Badge.count(
                  count: pendingLeaves,
                  isLabelVisible: pendingLeaves > 0,
                  child: const Icon(Icons.luggage_outlined),
                ),
                selectedIcon: Badge.count(
                  count: pendingLeaves,
                  isLabelVisible: pendingLeaves > 0,
                  child: const Icon(Icons.luggage),
                ),
                label: 'Leaves',
              ),
              const NavigationDestination(
                icon: Icon(Icons.manage_search_outlined),
                selectedIcon: Icon(Icons.manage_search),
                label: 'History',
              ),
              const NavigationDestination(
                icon: Icon(Icons.settings_outlined),
                selectedIcon: Icon(Icons.settings),
                label: 'Settings',
              ),
            ],
          );
        },
      ),
    );
  }
}
