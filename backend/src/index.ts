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
