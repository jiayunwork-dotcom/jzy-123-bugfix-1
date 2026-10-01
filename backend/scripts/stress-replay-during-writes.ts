// 写入过程中穿插全量重放：结束后（不做额外重放）增量读模型必须与独立回放逐字段相同
import pg from 'pg';
import { AccountService } from '../src/aggregates/accountService.js';
import { runMigrations } from '../src/db/migrate.js';
import { EventStore } from '../src/events/eventStore.js';
import { SnapshotStore } from '../src/events/snapshotStore.js';
import { AccountProjection } from '../src/projections/accountProjection.js';
import { evolveAccount, initialAccountState, type AccountEvent, type AccountState } from '../src/domain/account.js';

const URL = process.env.TEST_DATABASE_URL ?? 'postgres://es:es@localhost:5432/event_sourcing_test';
const N = Number(process.env.N ?? 40);
const K = Number(process.env.K ?? 25);

const pool = new pg.Pool({ connectionString: URL, max: 50 });

async function main() {
  await pool.query(`
    DROP TABLE IF EXISTS events, snapshots, projection_accounts, projection_checkpoints, projection_stream_positions, aggregates CASCADE;
    DROP FUNCTION IF EXISTS reject_event_mutation CASCADE;
  `);
  await runMigrations(pool);

  const eventStore = new EventStore(pool);
  const snapshotStore = new SnapshotStore(pool);
  const projection = new AccountProjection(pool, eventStore);
  const accountService = new AccountService(eventStore, snapshotStore, projection);

  await Promise.all(
    Array.from({ length: N }, (_, i) =>
      accountService.executeCommand(`acct-${i}`, { type: 'CreateAccount', owner: `u${i}` }, 0),
    ),
  );

  // 后台：写入进行中反复触发全量重放
  let replays = 0;
  let replayErrors = 0;
  let writing = true;
  const replayer = (async () => {
    while (writing) {
      await new Promise((r) => setTimeout(r, 5));
      try {
        await projection.replay();
        replays += 1;
      } catch (e) {
        replayErrors += 1;
        console.error('replay error:', (e as Error).message);
      }
    }
  })();

  await Promise.all(
    Array.from({ length: N }, async (_, i) => {
      const id = `acct-${i}`;
      for (let v = 1; v <= K; v += 1) {
        await accountService.executeCommand(id, { type: 'DepositMoney', amountCents: 100 }, v);
      }
    }),
  );
  writing = false;
  await replayer;

  // 写后跟进本来就在 executeCommand 里；这里最终再补一次（不调用 replay）
  await projection.processNewEvents();

  const status = await projection.status();
  const independent = new Map<string, { balanceCents: number; version: number }>();
  const events = await eventStore.loadAllEvents();
  for (const e of events) {
    const prev = (independent.get(e.aggregateId) ?? { ...initialAccountState, version: 0 }) as AccountState & { version: number };
    const next = evolveAccount(prev, e as AccountEvent);
    independent.set(e.aggregateId, { ...next, version: e.version });
  }

  let mismatches = 0;
  for (const row of status.accounts) {
    const want = independent.get(row.aggregateId)!;
    if (row.balanceCents !== want.balanceCents || row.version !== want.version) {
      mismatches += 1;
      console.log(`MISMATCH ${row.aggregateId}: projection(${row.balanceCents}, v=${row.version}) independent(${want.balanceCents}, v=${want.version})`);
    }
  }
  console.log(JSON.stringify({
    replays,
    replayErrors,
    accounts: status.accounts.length,
    eventTotal: events.length,
    processedEvents: status.processedEvents,
    lag: status.lagEvents,
    caughtUp: status.caughtUp,
    projectionTotal: status.summary.totalBalanceCents,
    expectedTotal: N * K * 100,
    mismatches,
  }, null, 2));

  await pool.end();
  process.exit(mismatches === 0 ? 0 : 2);
}

main().catch((e) => { console.error(e); process.exit(1); });
