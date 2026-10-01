import pg from 'pg';
import { AccountService } from '../src/aggregates/accountService.js';
import { runMigrations } from '../src/db/migrate.js';
import { EventStore } from '../src/events/eventStore.js';
import { SnapshotStore } from '../src/events/snapshotStore.js';
import { AccountProjection } from '../src/projections/accountProjection.js';
import { TEST_DATABASE_URL } from './globalSetup.js';

export interface TestDeps {
  pool: pg.Pool;
  eventStore: EventStore;
  snapshotStore: SnapshotStore;
  projection: AccountProjection;
  accountService: AccountService;
}

/** 每个测试文件一套依赖，共享同一个测试库 */
export async function setupTestDeps(): Promise<TestDeps> {
  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 10 });
  await resetDatabase(pool);
  const eventStore = new EventStore(pool);
  const snapshotStore = new SnapshotStore(pool);
  const projection = new AccountProjection(pool, eventStore);
  const accountService = new AccountService(eventStore, snapshotStore, projection);
  return { pool, eventStore, snapshotStore, projection, accountService };
}

/**
 * 重置数据库：整表 DROP 后重跑迁移。
 * （events 表有防 TRUNCATE/DELETE 的不可变触发器，测试清库只能整表重建——
 *  这本身也验证了触发器确实拦得住删除。）
 */
export async function resetDatabase(pool: pg.Pool): Promise<void> {
  await pool.query(`
    DROP TABLE IF EXISTS events, snapshots, projection_accounts, projection_checkpoints, projection_stream_checkpoints, aggregates CASCADE;
    DROP FUNCTION IF EXISTS reject_event_mutation CASCADE;
  `);
  await runMigrations(pool);
}

export async function teardownTestDeps(deps: TestDeps): Promise<void> {
  await deps.pool.end();
}
