/**
 * PM2 process model for the multi-instance stage.
 *
 *   npm run build          # tsc -> dist/
 *   npx prisma migrate deploy
 *   pm2 start ecosystem.config.js
 *
 * Port derivation: PM2 sets NODE_APP_INSTANCE=0,1,2 for cluster workers.
 * src/config/instance.ts resolves PORT = 3001 + NODE_APP_INSTANCE, so the
 * three API workers listen on 3001, 3002 and 3003 — exactly the ports listed
 * in nginx.conf's upstream block.
 *
 * PM2 cluster mode is used here to run three independent Node processes that
 * each own a port. PM2's automatic port sharing / round-robin is NOT used:
 * nginx is the load balancer, and WebSocket-only clients need no affinity.
 */
module.exports = {
  apps: [
    {
      name: 'api',
      script: 'dist/index.js',
      instances: 3,
      exec_mode: 'cluster',
      // Do NOT set PORT here: it is per-worker and must come from
      // NODE_APP_INSTANCE. Setting one PORT would make all three workers
      // fight over the same socket.
      env: {
        NODE_ENV: 'production',
      },
      max_memory_restart: '300M',
      kill_timeout: 5000,
      merge_logs: true,
      time: true,
    },
    {
      name: 'worker',
      script: 'dist/workers/escalation.worker.js',
      // ⚠️⚠️ BULLMQ WORKERS MUST NOT BE CLUSTERED. ⚠️⚠️
      // instances MUST stay 1 and exec_mode MUST stay "fork".
      // BullMQ does not coordinate multiple consumers of the same delayed
      // job for our escalation semantics: two workers = two SMS sends for
      // one unacknowledged alert. Scaling workers requires a distributed
      // lock / job-id ownership pattern and is deliberately out of scope.
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
      },
      max_memory_restart: '300M',
      kill_timeout: 10000,
      merge_logs: true,
      time: true,
    },
  ],
};
