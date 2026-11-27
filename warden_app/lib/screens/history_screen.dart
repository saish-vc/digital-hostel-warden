import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:share_plus/share_plus.dart';

import '../models/history.dart';
import '../models/paging.dart';
import '../services/api.dart';
import '../services/formatting.dart';
import '../state/app_scope.dart';
import '../theme.dart';
import '../widgets/common.dart';
import '../widgets/indicators.dart';

class HistoryScreen extends StatefulWidget {
  const HistoryScreen({super.key});

  @override
  State<HistoryScreen> createState() => _HistoryScreenState();
}

class _HistoryScreenState extends State<HistoryScreen> {
  final _search = TextEditingController();
  String? _status;
  DateTime? _from;
  DateTime? _to;
  int _page = 1;
  ApiPage<HistoryRow>? _data;
  bool _loading = false;
  bool _exporting = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _load(page: 1));
  }

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  Future<void> _load({int? page}) async {
    final app = AppScope.read(context);
    final target = page ?? _page;
    setState(() {
      _loading = true;
      _error = null;
      _page = target;
    });
    try {
      final result = await app.api.fetchHistory(
        page: target,
        status: _status,
        from: _from == null ? null : localDayStart(_from!),
        to: _to == null ? null : localDayEnd(_to!),
        studentName: _search.text.trim().isEmpty ? null : _search.text.trim(),
      );
      if (!mounted) return;
      setState(() => _data = result);
    } on ApiException catch (error) {
      if (!mounted) return;
      setState(() => _error = error.message);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _pickDate({required bool from}) async {
    final now = DateTime.now();
    final initial = (from ? _from : _to) ?? now;
    final picked = await showDatePicker(
      context: context,
      initialDate: initial,
      firstDate: DateTime(now.year - 2),
      lastDate: now,
      helpText: from ? 'Alerts from this day' : 'Alerts up to this day',
    );
    if (picked == null) return;
    setState(() {
      if (from) {
        _from = picked;
        if (_to != null && _to!.isBefore(picked)) _to = picked;
      } else {
        _to = picked;
        if (_from != null && _from!.isAfter(picked)) _from = picked;
      }
    });
    await _load(page: 1);
  }

  Future<void> _export() async {
    final app = AppScope.read(context);
    setState(() => _exporting = true);
    try {
      final csv = await app.api.fetchHistoryCsv(
        status: _status,
        from: _from == null ? null : localDayStart(_from!),
        to: _to == null ? null : localDayEnd(_to!),
        studentName: _search.text.trim().isEmpty ? null : _search.text.trim(),
      );
      final stamp = DateFormat('yyyyMMdd-HHmm').format(DateTime.now());
      await SharePlus.instance.share(
        ShareParams(
          files: [
            XFile.fromData(
              Uint8List.fromList(utf8.encode(csv)),
              mimeType: 'text/csv',
              name: 'hostelguard-alerts-$stamp.csv',
            ),
          ],
          subject: 'HostelGuard alert history',
          text: 'HostelGuard alert history exported from the warden app.',
        ),
      );
    } on ApiException catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(error.message)),
        );
      }
    } catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Export failed: $error')),
        );
      }
    } finally {
      if (mounted) setState(() => _exporting = false);
    }
  }

  void _resetFilters() {
    setState(() {
      _status = null;
      _from = null;
      _to = null;
      _search.clear();
    });
    _load(page: 1);
  }

  @override
  Widget build(BuildContext context) {
    final data = _data;
    final rows = data?.data ?? const <HistoryRow>[];
    final hasFilters = _status != null ||
        _from != null ||
        _to != null ||
        _search.text.trim().isNotEmpty;

    return Scaffold(
      appBar: AppBar(
        title: const Text(
          'History',
          style: TextStyle(fontWeight: FontWeight.w700),
        ),
        actions: [
          const Padding(
            padding: EdgeInsets.only(right: 4),
            child: Center(child: ConnectionDot()),
          ),
          IconButton(
            tooltip: 'Export CSV',
            onPressed: _exporting ? null : _export,
            icon: _exporting
                ? const SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.ios_share),
          ),
          const SizedBox(width: 4),
        ],
      ),
      body: RefreshIndicator(
        color: AppColors.accent,
        backgroundColor: AppColors.surface,
        onRefresh: () => _load(),
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
          children: [
            _FilterCard(
              search: _search,
              status: _status,
              from: _from,
              to: _to,
              hasFilters: hasFilters,
              onSearch: () => _load(page: 1),
              onStatus: (value) {
                setState(() => _status = value);
                _load(page: 1);
              },
              onPickFrom: () => _pickDate(from: true),
              onPickTo: () => _pickDate(from: false),
              onReset: _resetFilters,
            ),
            if (_error != null) ...[
              const SizedBox(height: 10),
              ErrorBanner(message: _error!, onRetry: () => _load()),
            ],
            const SizedBox(height: 12),
            Row(
              children: [
                Text(
                  data == null
                      ? 'Loading…'
                      : '${data.total} alert${data.total == 1 ? '' : 's'}',
                  style: const TextStyle(
                    color: AppColors.muted,
                    fontSize: 12,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                const Spacer(),
                if (data != null && data.totalPages > 1)
                  Text(
                    'Page ${data.page} of ${data.totalPages}',
                    style: const TextStyle(
                      color: AppColors.faint,
                      fontSize: 11,
                    ),
                  ),
              ],
            ),
            const SizedBox(height: 8),
            if (_loading && rows.isEmpty)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 48),
                child: Center(child: CircularProgressIndicator()),
              )
            else if (rows.isEmpty)
              const EmptyState(
                icon: Icons.manage_search,
                title: 'No alerts in this range',
                subtitle: 'Widen the dates or clear the status filter.',
              )
            else
              for (final row in rows) ...[
                _HistoryCard(row: row),
                const SizedBox(height: 8),
              ],
            if (data != null && data.totalPages > 1) ...[
              const SizedBox(height: 6),
              Row(
                children: [
                  Expanded(
                    child: OutlinedButton.icon(
                      onPressed: data.hasPrevious && !_loading
                          ? () => _load(page: data.page - 1)
                          : null,
                      icon: const Icon(Icons.chevron_left, size: 18),
                      label: const Text('Newer'),
                    ),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: OutlinedButton.icon(
                      onPressed: data.hasNext && !_loading
                          ? () => _load(page: data.page + 1)
                          : null,
                      icon: const Icon(Icons.chevron_right, size: 18),
                      label: const Text('Older'),
                    ),
                  ),
                ],
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _FilterCard extends StatelessWidget {
  const _FilterCard({
    required this.search,
    required this.status,
    required this.from,
    required this.to,
    required this.hasFilters,
    required this.onSearch,
    required this.onStatus,
    required this.onPickFrom,
    required this.onPickTo,
    required this.onReset,
  });

  final TextEditingController search;
  final String? status;
  final DateTime? from;
  final DateTime? to;
  final bool hasFilters;
  final VoidCallback onSearch;
  final ValueChanged<String?> onStatus;
  final VoidCallback onPickFrom;
  final VoidCallback onPickTo;
  final VoidCallback onReset;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: AppColors.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          TextField(
            controller: search,
            textInputAction: TextInputAction.search,
            onSubmitted: (_) => onSearch(),
            decoration: InputDecoration(
              labelText: 'Student name',
              prefixIcon: const Icon(Icons.person_search_outlined),
              suffixIcon: IconButton(
                tooltip: 'Search',
                onPressed: onSearch,
                icon: const Icon(Icons.search),
              ),
            ),
          ),
          const SizedBox(height: 10),
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: Row(
              children: [
                for (final entry in const [
                  (null, 'All'),
                  ('PENDING', 'Pending'),
                  ('ACKNOWLEDGED', 'Acknowledged'),
                  ('RESOLVED', 'Resolved'),
                ]) ...[
                  ChoiceChip(
                    label: Text(entry.$2),
                    selected: status == entry.$1,
                    onSelected: (_) => onStatus(entry.$1),
                  ),
                  const SizedBox(width: 6),
                ],
              ],
            ),
          ),
          const SizedBox(height: 10),
          Row(
            children: [
              Expanded(
                child: OutlinedButton.icon(
                  onPressed: onPickFrom,
                  icon: const Icon(Icons.event, size: 16),
                  label: Text(
                    from == null ? 'From date' : dayOnly(from),
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: OutlinedButton.icon(
                  onPressed: onPickTo,
                  icon: const Icon(Icons.event_available, size: 16),
                  label: Text(
                    to == null ? 'To date' : dayOnly(to),
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
              ),
            ],
          ),
          if (hasFilters) ...[
            const SizedBox(height: 4),
            Align(
              alignment: Alignment.centerRight,
              child: TextButton.icon(
                onPressed: onReset,
                icon: const Icon(Icons.filter_alt_off, size: 16),
                label: const Text('Clear filters'),
              ),
            ),
          ],
        ],
      ),
    );
  }
}

class _HistoryCard extends StatelessWidget {
  const _HistoryCard({required this.row});

  final HistoryRow row;

  @override
  Widget build(BuildContext context) {
    final note = row.resolutionNote ?? '';
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: AppColors.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  row.studentName.isEmpty ? 'Unknown student' : row.studentName,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    fontWeight: FontWeight.w600,
                    fontSize: 14,
                  ),
                ),
              ),
              const SizedBox(width: 8),
              StatusPill(status: row.status),
            ],
          ),
          const SizedBox(height: 2),
          Text(
            'Room ${row.roomNumber} · ${typeLabel(row.type)}',
            style: const TextStyle(color: AppColors.muted, fontSize: 12),
          ),
          const SizedBox(height: 8),
          Wrap(
            spacing: 6,
            runSpacing: 6,
            children: [
              Tag(
                text: dateMedium(row.createdAt),
                icon: Icons.schedule,
              ),
              if ((row.acknowledgedByName ?? '').isNotEmpty)
                Tag(
                  text: row.acknowledgedByName!,
                  icon: Icons.person_outline,
                ),
              if (row.resolvedAt != null)
                Tag(
                  text: 'Resolved ${timeShort(row.resolvedAt)}',
                  icon: Icons.task_alt,
                  color: AppColors.resolved,
                ),
            ],
          ),
          if (note.isNotEmpty) ...[
            const SizedBox(height: 8),
            Text(
              note,
              maxLines: 3,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(color: AppColors.text, fontSize: 12),
            ),
          ],
        ],
      ),
    );
  }
}
