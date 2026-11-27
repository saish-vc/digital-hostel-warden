import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:socket_io_client/socket_io_client.dart' as sio;

import '../config.dart';

enum SocketStatus { disconnected, connecting, connected }

typedef SocketEventHandler = void Function(
  String event,
  Map<String, dynamic> payload,
);

/// One socket per app process, WebSocket-only, auth through a callback so a
/// reconnect always presents the current JWT.
class SocketService {
  SocketService._();

  static final SocketService instance = SocketService._();

  static const List<String> events = [
    'alert:new',
    'alert:updated',
    'alert:resolved',
    'alert:escalated',
    'alert:escalation_failed',
    'leave:created',
    'leave:updated',
    'leave:departed',
    'leave:returned',
    'leave:cancelled',
  ];

  final ValueNotifier<SocketStatus> status =
      ValueNotifier(SocketStatus.disconnected);

  sio.Socket? _socket;
  SocketEventHandler? _onEvent;
  VoidCallback? _onConnected;
  VoidCallback? _onUnauthorized;

  bool get isConnected => _socket?.connected ?? false;

  void connect(
    String token, {
    required SocketEventHandler onEvent,
    VoidCallback? onConnected,
    VoidCallback? onUnauthorized,
  }) {
    disconnect();
    _onEvent = onEvent;
    _onConnected = onConnected;
    _onUnauthorized = onUnauthorized;
    status.value = SocketStatus.connecting;

    final socket = sio.io(
      AppConfig.socketUrl,
      sio.OptionBuilder()
          .setTransports(['websocket'])
          .setAuth({'token': token})
          .enableReconnection()
          .disableAutoConnect()
          .build(),
    );
    _socket = socket;

    socket.onConnect((_) {
      status.value = SocketStatus.connected;
      _onConnected?.call();
    });
    socket.onDisconnect((_) {
      status.value = SocketStatus.disconnected;
    });
    socket.onConnectError((error) {
      status.value = SocketStatus.disconnected;
      final text = error is Map
          ? '${error['message'] ?? error['data'] ?? error}'
          : '$error';
      if (text.toUpperCase().contains('UNAUTHORIZED')) {
        _onUnauthorized?.call();
      }
    });

    for (final event in events) {
      socket.on(event, (data) {
        final payload = _asPayload(data);
        if (payload != null) _onEvent?.call(event, payload);
      });
    }

    socket.connect();
  }

  Map<String, dynamic>? _asPayload(dynamic data) {
    if (data is Map<String, dynamic>) return data;
    if (data is Map) return data.cast<String, dynamic>();
    if (data is String) {
      try {
        final decoded = jsonDecode(data);
        if (decoded is Map) return decoded.cast<String, dynamic>();
      } on FormatException {
        return null;
      }
    }
    return null;
  }

  void disconnect() {
    final socket = _socket;
    _socket = null;
    _onEvent = null;
    _onConnected = null;
    _onUnauthorized = null;
    status.value = SocketStatus.disconnected;
    if (socket != null) {
      socket.dispose();
    }
  }
}
