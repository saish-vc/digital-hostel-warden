import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart' show kReleaseMode;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'config.dart';
import 'screens/app_shell.dart';
import 'screens/login_screen.dart';
import 'services/notifications.dart';
import 'services/push.dart';
import 'state/app_scope.dart';
import 'state/app_state.dart';
import 'theme.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  if (kReleaseMode && !AppConfig.hasApiBase) {
    throw StateError(
      'Release builds must pass '
      '--dart-define=API_BASE_URL=https://<host> (cleartext is blocked).',
    );
  }
  await SystemChrome.setPreferredOrientations([
    DeviceOrientation.portraitUp,
    DeviceOrientation.portraitDown,
  ]);

  final state = AppState();
  try {
    await Firebase.initializeApp();
    // Must be registered before runApp so a killed-state delivery can start
    // the background isolate.
    FirebaseMessaging.onBackgroundMessage(firebaseBackgroundHandler);
  } catch (error) {
    // The board still works over HTTP/socket; only push is degraded.
    debugPrint('[firebase] initialization failed: $error');
  }
  try {
    await NotificationService.init(
      onTap: (alertId) => state.pendingOpenAlert.value = alertId,
    );
  } catch (error) {
    debugPrint('[notifications] initialization failed: $error');
  }
  await state.init();

  runApp(WardenApp(state: state));
}

class WardenApp extends StatelessWidget {
  const WardenApp({super.key, required this.state});

  final AppState state;

  static final GlobalKey<NavigatorState> navigatorKey =
      GlobalKey<NavigatorState>();

  @override
  Widget build(BuildContext context) {
    return AppScope(
      state: state,
      child: MaterialApp(
        title: AppConfig.appName,
        debugShowCheckedModeBanner: false,
        theme: AppTheme.dark(),
        navigatorKey: navigatorKey,
        home: const _Root(),
      ),
    );
  }
}

class _Root extends StatefulWidget {
  const _Root();

  @override
  State<_Root> createState() => _RootState();
}

class _RootState extends State<_Root> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      AppScope.read(context).onSessionEnded = () {
        WardenApp.navigatorKey.currentState?.popUntil((route) => route.isFirst);
      };
    });
  }

  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    return switch (app.phase) {
      SessionPhase.restoring => const _Splash(),
      SessionPhase.loggedOut => const LoginScreen(),
      SessionPhase.loggedIn => const AppShell(),
    };
  }
}

class _Splash extends StatelessWidget {
  const _Splash();

  @override
  Widget build(BuildContext context) {
    return const Scaffold(
      body: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.shield_moon_outlined, size: 56, color: AppColors.accent),
            SizedBox(height: 16),
            Text(
              'HostelGuard Warden',
              style: TextStyle(fontSize: 20, fontWeight: FontWeight.w700),
            ),
            SizedBox(height: 20),
            SizedBox(
              width: 22,
              height: 22,
              child: CircularProgressIndicator(strokeWidth: 2),
            ),
          ],
        ),
      ),
    );
  }
}
