import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:warden_app/services/formatting.dart';
import 'package:warden_app/widgets/indicators.dart';

void main() {
  test('typeLabel renders every server type, including leave-prefixed ones', () {
    expect(typeLabel('MEDICAL'), 'Medical');
    expect(typeLabel('FIRE'), 'Fire');
    expect(typeLabel('MENTAL_HEALTH'), 'Mental health');
    expect(typeLabel('OFF_CAMPUS_LEAVE:FIRE'), 'Leave · Fire');
    expect(typeLabel('SOMETHING_NEW'), 'SOMETHING_NEW');
    expect(typeLabel(''), 'Unknown');
  });

  test('accuracyLabel is empty when the device did not send a fix', () {
    expect(accuracyLabel(null), '');
    expect(accuracyLabel(0), '');
    expect(accuracyLabel(12.4), '±12 m');
  });

  test('lateBy is only late after the expected return', () {
    final expected = DateTime(2026, 11, 27, 18, 0);
    expect(lateBy(expected, now: DateTime(2026, 11, 27, 17, 30)), 'on time');
    expect(lateBy(expected, now: DateTime(2026, 11, 27, 18, 20)), '20m late');
    expect(lateBy(expected, now: DateTime(2026, 11, 27, 20, 5)), '2h 05m late');
  });

  testWidgets('EscalationPill only claims SMS when the server set escalatedAt',
      (tester) async {
    await tester.pumpWidget(
      const MaterialApp(
        home: Scaffold(body: Center(child: EscalationPill(escalatedAt: null))),
      ),
    );
    expect(find.textContaining('SMS sent'), findsNothing);

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Center(
            child: EscalationPill(
              escalatedAt: DateTime(2026, 11, 27, 10, 42),
            ),
          ),
        ),
      ),
    );
    expect(find.textContaining('SMS sent'), findsOneWidget);
  });
}
