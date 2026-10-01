import { AccountService } from './aggregates/accountService.js';
import { loadConfig } from './config.js';
import { runMigrations, waitForDatabase } from './db/migrate.js';
import { createPool } from './db/pool.js';
import { EventStore } from './events/eventStore.js';
import { SnapshotStore } from './events/snapshotStore.js';
import { buildServer } from './http/server.js';
import { AccountProjection } from './projections/accountProjection.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);

  await waitForDatabase(pool);
  await runMigrations(pool);

  const eventStore = new EventStore(pool);
  const snapshotStore = new SnapshotStore(pool);
  const projection = new AccountProjection(pool, eventStore);
  const accountService = new AccountService(eventStore, snapshotStore, projection);

  // 启动先跟进一次：服务重启期间写入积累的事件、或上次运行末尾跟进失败留下的差距，
  // 在对外提供服务前补齐。位点是持久化的，只需补增量，不会重放全量。
  await projection.processNewEvents().catch((err) => {
    console.error('initial projection catch-up failed (will retry via poll):', err);
  });

  // 兜底轮询：写后跟进失败时，最迟下一轮补齐；轮询间隔内的落后由接口的
  // lagEvents/caughtUp 如实暴露，不会再报"已追平"的假位点。
  let pollTimer: NodeJS.Timeout | null = null;
  let stopped = false;
  const pollOnce = async () => {
    try {
      await projection.processNewEvents();
    } catch (err) {
      console.error('projection catch-up poll failed:', err);
    } finally {
      if (!stopped && config.projectionCatchUpPollMs > 0) {
        pollTimer = setTimeout(pollOnce, config.projectionCatchUpPollMs);
      }
    }
  };
  if (config.projectionCatchUpPollMs > 0) {
    pollTimer = setTimeout(pollOnce, config.projectionCatchUpPollMs);
  }

  const app = await buildServer(
    { eventStore, snapshotStore, accountService, projection },
    { logger: true },
  );
  await app.listen({ port: config.port, host: '0.0.0.0' });

  const shutdown = async () => {
    stopped = true;
    if (pollTimer) clearTimeout(pollTimer);
    await app.close();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('fatal: failed to start server', err);
  process.exit(1);
});
