import 'package:flutter/material.dart';

import '../config.dart';
import '../state/app_scope.dart';
import '../theme.dart';

class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _email = TextEditingController(text: AppConfig.showDemoHint ? AppConfig.demoEmail : '');
  final _password =
      TextEditingController(text: AppConfig.showDemoHint ? AppConfig.demoPassword : '');
  bool _obscure = true;
  bool _submitting = false;

  @override
  void dispose() {
    _email.dispose();
    _password.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final app = AppScope.read(context);
    final email = _email.text.trim();
    final password = _password.text;
    if (email.isEmpty || password.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Enter your email and password.')),
      );
      return;
    }
    setState(() => _submitting = true);
    await app.login(email, password);
    if (mounted) setState(() => _submitting = false);
  }

  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    final error = app.loginError;
    final notice = app.notice;

    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  const Icon(
                    Icons.shield_moon_outlined,
                    size: 56,
                    color: AppColors.accent,
                  ),
                  const SizedBox(height: 14),
                  const Text(
                    'HostelGuard Warden',
                    textAlign: TextAlign.center,
                    style: TextStyle(
                      fontSize: 24,
                      fontWeight: FontWeight.w700,
                      letterSpacing: 0.2,
                    ),
                  ),
                  const SizedBox(height: 4),
                  const Text(
                    'Sign in to the warden desk',
                    textAlign: TextAlign.center,
                    style: TextStyle(color: AppColors.muted),
                  ),
                  const SizedBox(height: 28),
                  if (notice != null) ...[
                    Container(
                      padding: const EdgeInsets.all(10),
                      decoration: BoxDecoration(
                        color: AppColors.acknowledged.withValues(alpha: 0.12),
                        borderRadius: BorderRadius.circular(10),
                        border: Border.all(
                          color: AppColors.acknowledged.withValues(alpha: 0.4),
                        ),
                      ),
                      child: Text(
                        notice,
                        style: const TextStyle(
                          color: AppColors.acknowledged,
                          fontSize: 12,
                        ),
                      ),
                    ),
                    const SizedBox(height: 14),
                  ],
                  TextField(
                    controller: _email,
                    enabled: !_submitting,
                    keyboardType: TextInputType.emailAddress,
                    textInputAction: TextInputAction.next,
                    autocorrect: false,
                    decoration: const InputDecoration(
                      labelText: 'Email',
                      prefixIcon: Icon(Icons.mail_outline),
                    ),
                    onChanged: (_) => app.clearLoginError(),
                  ),
                  const SizedBox(height: 12),
                  TextField(
                    controller: _password,
                    enabled: !_submitting,
                    obscureText: _obscure,
                    textInputAction: TextInputAction.done,
                    onSubmitted: (_) {
                      if (!_submitting) _submit();
                    },
                    decoration: InputDecoration(
                      labelText: 'Password',
                      prefixIcon: const Icon(Icons.lock_outline),
                      suffixIcon: IconButton(
                        tooltip: _obscure ? 'Show password' : 'Hide password',
                        icon: Icon(
                          _obscure ? Icons.visibility_outlined : Icons.visibility_off_outlined,
                        ),
                        onPressed: () => setState(() => _obscure = !_obscure),
                      ),
                    ),
                    onChanged: (_) => app.clearLoginError(),
                  ),
                  if (error != null) ...[
                    const SizedBox(height: 14),
                    Text(
                      error,
                      style: const TextStyle(color: AppColors.pending, fontSize: 13),
                    ),
                  ],
                  const SizedBox(height: 20),
                  FilledButton(
                    onPressed: _submitting ? null : _submit,
                    child: _submitting
                        ? const SizedBox(
                            width: 20,
                            height: 20,
                            child: CircularProgressIndicator(
                              strokeWidth: 2,
                              color: Colors.white,
                            ),
                          )
                        : const Text('Sign in'),
                  ),
                  const SizedBox(height: 18),
                  if (AppConfig.showDemoHint)
                    const Text(
                      'Demo: warden@hostel.local / password123',
                      textAlign: TextAlign.center,
                      style: TextStyle(color: AppColors.faint, fontSize: 11),
                    ),
                  const SizedBox(height: 8),
                  Text(
                    AppConfig.apiBase,
                    textAlign: TextAlign.center,
                    style: const TextStyle(color: AppColors.faint, fontSize: 10),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
