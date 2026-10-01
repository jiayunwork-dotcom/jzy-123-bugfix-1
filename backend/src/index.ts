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

  // 启动时增量补齐一次：进程崩溃或跟进失败期间落下的已提交事件，
  // 重启后自动追上（按每聚合流检查点继续，不依赖全局序号，绝不重复应用）。
  try {
    const processed = await projection.processNewEvents();
    if (processed > 0) {
      console.log(`projection caught up ${processed} event(s) on startup`);
    }
  } catch (err) {
    // 读模型是派生物：启动补齐失败不应阻止 API 起服，状态接口会如实暴露落后。
    console.error('projection startup catch-up failed (read model is lagging):', err);
  }

  const app = await buildServer(
    { eventStore, snapshotStore, accountService, projection },
    { logger: true },
  );
  await app.listen({ port: config.port, host: '0.0.0.0' });

  const shutdown = async () => {
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
