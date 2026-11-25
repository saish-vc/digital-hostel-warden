import { io } from 'socket.io-client';
import { API_URL, getToken } from '../api/client';

// WebSocket-only is a deliberate deployment decision: no long-polling means
// no sticky sessions at the load balancer/tunnel, and the Redis adapter
// handles cross-instance fan-out. autoConnect is off and auth is a callback
// so every (re)connect sends the CURRENT JWT, not the one at import time.
export const socket = io(new URL(API_URL).origin, {
  transports: ['websocket'],
  withCredentials: true,
  autoConnect: false,
  auth: (cb) => cb({ token: getToken() }),
});
