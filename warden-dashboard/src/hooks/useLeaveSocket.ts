import { useEffect, useRef } from 'react';
import { socket } from '../lib/socket';

export type LeaveSocketEvent = 'created' | 'updated' | 'departed' | 'returned' | 'cancelled';

/**
 * Live feed for the leave board. The server emits `leave:created` to the
 * `wardens` room on submission and `leave:updated` / `leave:departed` /
 * `leave:returned` / `leave:cancelled` on every later transition, so the
 * board never depends on a refresh timer.
 *
 * The same process-wide socket instance is shared with `useAlertSocket`;
 * each hook removes only its own listeners on unmount.
 */
export function useLeaveSocket(
  onLeaveEvent: (event: LeaveSocketEvent, payload: unknown) => void,
): void {
  const handlerRef = useRef(onLeaveEvent);
  handlerRef.current = onLeaveEvent;

  useEffect(() => {
    socket.connect();

    const listeners: Array<[string, (payload: unknown) => void]> = [
      ['leave:created', (payload) => handlerRef.current('created', payload)],
      ['leave:updated', (payload) => handlerRef.current('updated', payload)],
      ['leave:departed', (payload) => handlerRef.current('departed', payload)],
      ['leave:returned', (payload) => handlerRef.current('returned', payload)],
      ['leave:cancelled', (payload) => handlerRef.current('cancelled', payload)],
    ];

    for (const [event, handler] of listeners) {
      socket.on(event, handler);
    }

    return () => {
      for (const [event, handler] of listeners) {
        socket.off(event, handler);
      }
      socket.disconnect();
    };
  }, []);
}
