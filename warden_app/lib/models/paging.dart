class ApiPage<T> {
  const ApiPage({
    required this.data,
    required this.page,
    required this.limit,
    required this.total,
    required this.totalPages,
  });

  final List<T> data;
  final int page;
  final int limit;
  final int total;
  final int totalPages;

  bool get hasPrevious => page > 1;
  bool get hasNext => page < totalPages;

  static const empty = ApiPage<Never>(
    data: [],
    page: 1,
    limit: 25,
    total: 0,
    totalPages: 1,
  );

  factory ApiPage.fromJson(
    Map<String, dynamic> json,
    T Function(Map<String, dynamic>) parse,
  ) {
    final raw = json['data'];
    final pagination = json['pagination'] is Map
        ? (json['pagination'] as Map).cast<String, dynamic>()
        : const <String, dynamic>{};
    final rows = raw is List
        ? raw
            .whereType<Map>()
            .map((row) => parse(row.cast<String, dynamic>()))
            .toList(growable: false)
        : <T>[];
    return ApiPage<T>(
      data: rows,
      page: _int(pagination['page'], 1),
      limit: _int(pagination['limit'], 25),
      total: _int(pagination['total'], rows.length),
      totalPages: _int(pagination['totalPages'], 1),
    );
  }

  static int _int(dynamic value, int fallback) =>
      value is num ? value.toInt() : fallback;
}
