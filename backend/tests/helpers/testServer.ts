import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import type { Server } from 'socket.io';
import { createApp } from '../../src/app';
import { prisma } from '../../src/config/prisma';
import {
  escalationQueue,
  escalationQueueConnection,
} from '../../src/queues/escalation.queue';

/**
 * Boots the REAL Express + Socket.IO app on an ephemeral port (0), backed by
 * the test Postgres and test Redis. Nothing here is mocked: supertest talks
 * HTTP to the same handlers production uses, and socket.io-client opens a
 * real WebSocket to the same server.
 *
 * Per-file lifecycle: `beforeAll(startTestServer)` / `afterAll(server.close)`.
 * close() also releases the module-level BullMQ queue connection, without
 * which Vitest would hang on an open ioredis handle.
 */
export interface TestServer {
  app: Express;
  io: Server;
  url: string;
  close: () => Promise<void>;
}

export async function startTestServer(): Promise<TestServer> {
  const bundle = createApp();

  await new Promise<void>((resolve, reject) => {
    bundle.httpServer.once('error', reject);
    bundle.httpServer.listen(0, '127.0.0.1', () => resolve());
  });

  const address = bundle.httpServer.address() as AddressInfo | null;
  if (!address || typeof address === 'string') {
    throw new Error('Test server did not expose a TCP port');
  }

  return {
    app: bundle.app,
    io: bundle.io,
    url: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise<void>((resolve) => bundle.io.close(() => resolve()));

      if (bundle.httpServer.listening) {
        await new Promise<void>((resolve) => bundle.httpServer.close(() => resolve()));
      }

      await escalationQueue.close().catch(() => undefined);
      await escalationQueueConnection.quit().catch(() => undefined);
      await prisma.$disconnect();
    },
  };
}
