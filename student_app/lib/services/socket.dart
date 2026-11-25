import 'package:flutter/foundation.dart';
import 'package:socket_io_client/socket_io_client.dart' as sio;

import '../config.dart';

/// One socket per app process. The backend joins the socket to
/// `student:<id>` automatically based on the JWT.
class SocketService {
  SocketService._();

  static final SocketService instance = SocketService._();

  sio.Socket? _socket;

  bool get isConnected => _socket?.connected ?? false;

  sio.Socket connect(
    String token, {
    required void Function(Map<String, dynamic> alert) onAlertUpdated,
    void Function(Map<String, dynamic> leave)? onLeaveEvent,
  }) {
    disconnect();

    final socket = sio.io(
      AppConfig.socketUrl,
      sio.OptionBuilder()
          // WebSocket-only on purpose: no HTTP long-polling means no sticky
          // session is needed at the load balancer. The connection stays
          // pinned to one API instance, and the server's Redis adapter
          // broadcasts alert events to every instance (see nginx.conf).
          .setTransports(['websocket'])
          .setAuth({'token': token})
          .enableReconnection()
          .build(),
    );

    socket.onConnect((_) {
      debugPrint('[socket] connected');
    });

    socket.onConnectError((error) {
      debugPrint('[socket] connect_error: $error');
    });

    socket.on('alert:updated', (data) {
      if (data is Map) {
        onAlertUpdated(Map<String, dynamic>.from(data));
      }
    });

    // Leave lifecycle: the server targets `student:<id>` on approval,
    // rejection, cancellation, departure and return. The payload is the full
    // updated row, so the status screen can re-render from it directly.
    if (onLeaveEvent != null) {
      for (final event in const [
        'leave:updated',
        'leave:departed',
        'leave:returned',
        'leave:cancelled',
      ]) {
        socket.on(event, (data) {
          if (data is Map) {
            onLeaveEvent(Map<String, dynamic>.from(data));
          }
        });
      }
    }

    _socket = socket;
    return socket;
  }

  void disconnect() {
    _socket?.dispose();
    _socket = null;
  }
}
