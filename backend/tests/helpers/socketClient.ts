import { io as createSocketClient, type Socket } from 'socket.io-client';

/**
 * socket.io-client helpers.
 *
 * `reconnection: false` is deliberate: a test that expects a rejection must
 * fail fast instead of silently reconnecting for 5 seconds, and a test that
 * drops a connection should observe the drop rather than a retry.
 */

export interface TestSocketOptions {
  token?: string;
}

export function createSocket(url: string, options: TestSocketOptions = {}): Socket {
  return createSocketClient(url, {
    auth: options.token === undefined ? {} : { token: options.token },
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
    timeout: 5_000,
  });
}

/** Connect and wait for the server's `connected` greeting. */
export async function connectAs(url: string, token: string): Promise<Socket> {
  const socket = createSocket(url, { token });
  await waitForEvent(socket, 'connected');
  return socket;
}

/** Connect with no token and expect the handshake to be rejected. */
export async function expectHandshakeRejection(
  url: string,
  options: TestSocketOptions = {},
): Promise<string> {
  const socket = createSocket(url, options);

  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.disconnect();
      reject(new Error('Expected the handshake to be rejected, but it did not resolve'));
    }, 5_000);

    socket.once('connect', () => {
      clearTimeout(timer);
      socket.disconnect();
      reject(new Error('Expected the handshake to be rejected, but the socket connected'));
    });

    socket.once('connect_error', (error: Error) => {
      clearTimeout(timer);
      socket.disconnect();
      resolve(error.message);
    });
  });
}

/** Resolve with the next payload for `event`, or reject after `timeoutMs`. */
export function waitForEvent<T = unknown>(
  socket: Socket,
  event: string,
  timeoutMs = 5_000,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const handler = (payload: T) => {
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    };

    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`Timed out after ${timeoutMs}ms waiting for socket event "${event}"`));
    }, timeoutMs);

    socket.on(event, handler);
  });
}

/**
 * Record every payload for an event into an array, so a test can assert that
 * NOTHING arrived (students must never receive other students' alerts).
 */
export function recordEvents<T = unknown>(socket: Socket, event: string): T[] {
  const received: T[] = [];
  socket.on(event, (payload: T) => received.push(payload));
  return received;
}

export function disconnectAll(sockets: Array<Socket | undefined | null>): void {
  for (const socket of sockets) {
    socket?.disconnect();
  }
}
