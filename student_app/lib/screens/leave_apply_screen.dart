import 'package:flutter/material.dart';

import '../services/api.dart';

/// Form for a new leave request. Mirrors `POST /leaves`: type, reason,
/// destination, optional emergency contact, departure and expected return.
class LeaveApplyScreen extends StatefulWidget {
  const LeaveApplyScreen({super.key});

  @override
  State<LeaveApplyScreen> createState() => _LeaveApplyScreenState();
}

class _LeaveApplyScreenState extends State<LeaveApplyScreen> {
  static const _types = <String, String>{
    'DAY_OUTING': 'Day outing',
    'NIGHT_OUT': 'Night out',
    'HOME_VISIT': 'Home visit',
    'MEDICAL': 'Medical',
  };

  final _formKey = GlobalKey<FormState>();
  final _reasonController = TextEditingController();
  final _destinationController = TextEditingController();
  final _contactController = TextEditingController();

  String _type = 'DAY_OUTING';
  late DateTime _departure;
  late DateTime _expectedReturn;
  bool _submitting = false;

  @override
  void initState() {
    super.initState();
    final now = DateTime.now();
    // A whole hour from now, rounded down to the minute: the backend rejects
    // a return that is not strictly after departure, and pickers are easier to
    // reason about on clean values.
    _departure = DateTime(now.year, now.month, now.day, now.hour + 1, 0);
    _expectedReturn = _departure.add(const Duration(hours: 4));
  }

  @override
  void dispose() {
    _reasonController.dispose();
    _destinationController.dispose();
    _contactController.dispose();
    super.dispose();
  }

  Future<DateTime?> _pickDateTime(DateTime initial) async {
    final now = DateTime.now();
    final date = await showDatePicker(
      context: context,
      initialDate: initial,
      // The backend rejects a departure in the past; the picker should not
      // offer yesterday in the first place.
      firstDate: DateTime(now.year, now.month, now.day),
      lastDate: now.add(const Duration(days: 60)),
    );
    if (date == null || !mounted) return null;

    final time = await showTimePicker(
      context: context,
      initialTime: TimeOfDay.fromDateTime(initial),
    );
    if (time == null) return null;

    return DateTime(date.year, date.month, date.day, time.hour, time.minute);
  }

  Future<void> _pickDeparture() async {
    final picked = await _pickDateTime(_departure);
    if (picked == null || !mounted) return;
    setState(() {
      _departure = picked;
      // Keep the return after departure instead of silently submitting an
      // invalid pair the server would reject with a 400.
      if (!_expectedReturn.isAfter(_departure)) {
        _expectedReturn = _departure.add(const Duration(hours: 4));
      }
    });
  }

  Future<void> _pickReturn() async {
    final picked = await _pickDateTime(_expectedReturn);
    if (picked == null || !mounted) return;
    setState(() => _expectedReturn = picked);
  }

  Future<void> _submit() async {
    if (!_formKey.currentState!.validate()) return;

    if (!_expectedReturn.isAfter(_departure)) {
      _showError('Expected return must be after departure.');
      return;
    }

    if (_departure.isBefore(DateTime.now().subtract(const Duration(minutes: 1)))) {
      _showError('Departure cannot be in the past.');
      return;
    }

    setState(() => _submitting = true);

    try {
      await ApiService.createLeave(
        type: _type,
        reason: _reasonController.text.trim(),
        destination: _destinationController.text.trim(),
        emergencyContact: _contactController.text,
        departureTime: _departure,
        expectedReturn: _expectedReturn,
      );

      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Leave request submitted for warden review.')),
      );
      Navigator.of(context).pop(true);
    } on ApiException catch (error) {
      _showError(error.message);
    } catch (_) {
      _showError('Could not reach the hostel server. Try again.');
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  void _showError(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(message), backgroundColor: Colors.red.shade800),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFF0B1120),
      appBar: AppBar(
        backgroundColor: Colors.transparent,
        elevation: 0,
        title: const Text('Apply for leave'),
      ),
      body: SafeArea(
        child: Form(
          key: _formKey,
          child: ListView(
            padding: const EdgeInsets.fromLTRB(20, 8, 20, 32),
            children: [
              const Text(
                'Your warden reviews every request before a gate pass is issued.',
                style: TextStyle(color: Colors.white54, fontSize: 13),
              ),
              const SizedBox(height: 20),
              DropdownButtonFormField<String>(
                initialValue: _type,
                decoration: _decoration('Leave type'),
                dropdownColor: const Color(0xFF111827),
                items: _types.entries
                    .map(
                      (entry) => DropdownMenuItem(
                        value: entry.key,
                        child: Text(entry.value),
                      ),
                    )
                    .toList(),
                onChanged: _submitting
                    ? null
                    : (value) {
                        if (value != null) setState(() => _type = value);
                      },
              ),
              const SizedBox(height: 16),
              TextFormField(
                controller: _destinationController,
                textCapitalization: TextCapitalization.sentences,
                decoration: _decoration('Destination', hint: 'Where are you going?'),
                validator: (value) =>
                    (value == null || value.trim().isEmpty) ? 'Destination is required' : null,
              ),
              const SizedBox(height: 16),
              TextFormField(
                controller: _reasonController,
                textCapitalization: TextCapitalization.sentences,
                minLines: 3,
                maxLines: 5,
                decoration: _decoration('Reason', hint: 'Why do you need this leave?'),
                validator: (value) =>
                    (value == null || value.trim().isEmpty) ? 'Reason is required' : null,
              ),
              const SizedBox(height: 16),
              TextFormField(
                controller: _contactController,
                keyboardType: TextInputType.phone,
                decoration: _decoration(
                  'Emergency contact (optional)',
                  hint: 'Defaults to the number on your profile',
                ),
              ),
              const SizedBox(height: 24),
              _DateTimeTile(
                label: 'Departure',
                value: _departure,
                onTap: _submitting ? null : _pickDeparture,
              ),
              if (_departure.isBefore(DateTime.now()))
                const Padding(
                  padding: EdgeInsets.only(top: 8),
                  child: Text(
                    'Departure cannot be in the past.',
                    style: TextStyle(color: Colors.redAccent, fontSize: 13),
                  ),
                ),
              const SizedBox(height: 12),
              _DateTimeTile(
                label: 'Expected return',
                value: _expectedReturn,
                onTap: _submitting ? null : _pickReturn,
              ),
              if (!_expectedReturn.isAfter(_departure))
                const Padding(
                  padding: EdgeInsets.only(top: 8),
                  child: Text(
                    'Return must be after departure.',
                    style: TextStyle(color: Colors.redAccent, fontSize: 13),
                  ),
                ),
              const SizedBox(height: 28),
              FilledButton.icon(
                onPressed: _submitting ? null : _submit,
                style: FilledButton.styleFrom(
                  backgroundColor: Colors.red.shade700,
                  foregroundColor: Colors.white,
                  minimumSize: const Size.fromHeight(52),
                ),
                icon: _submitting
                    ? const SizedBox(
                        width: 18,
                        height: 18,
                        child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                      )
                    : const Icon(Icons.send),
                label: Text(_submitting ? 'Submitting…' : 'Submit request'),
              ),
            ],
          ),
        ),
      ),
    );
  }

  InputDecoration _decoration(String label, {String? hint}) {
    return InputDecoration(
      labelText: label,
      hintText: hint,
      filled: true,
      fillColor: const Color(0xFF111827),
      border: OutlineInputBorder(borderRadius: BorderRadius.circular(14)),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(14),
        borderSide: const BorderSide(color: Color(0xFF1F2937)),
      ),
    );
  }
}

class _DateTimeTile extends StatelessWidget {
  const _DateTimeTile({required this.label, required this.value, this.onTap});

  final String label;
  final DateTime value;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(14),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
        decoration: BoxDecoration(
          color: const Color(0xFF111827),
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: const Color(0xFF1F2937)),
        ),
        child: Row(
          children: [
            const Icon(Icons.event, color: Colors.white54),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(label, style: const TextStyle(color: Colors.white54, fontSize: 12)),
                  const SizedBox(height: 2),
                  Text(
                    _format(value),
                    style: const TextStyle(color: Colors.white, fontSize: 16),
                  ),
                ],
              ),
            ),
            const Icon(Icons.edit_outlined, size: 18, color: Colors.white38),
          ],
        ),
      ),
    );
  }

  static const _months = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];

  static String _format(DateTime value) {
    final hour = value.hour.toString().padLeft(2, '0');
    final minute = value.minute.toString().padLeft(2, '0');
    return '${value.day} ${_months[value.month - 1]} ${value.year}, $hour:$minute';
  }
}
