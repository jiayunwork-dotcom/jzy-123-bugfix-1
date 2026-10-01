// 压测复现：N 个账户并发，每个账户内部按版本串行存 K 笔；直接对比增量读模型与独立回放
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

  // 先建 N 个账户
  await Promise.all(
    Array.from({ length: N }, (_, i) =>
      accountService.executeCommand(`acct-${i}`, { type: 'CreateAccount', owner: `u${i}` }, 0),
    ),
  );

  // N 个账户同时开跑；每户内部一笔等上一笔
  await Promise.all(
    Array.from({ length: N }, async (_, i) => {
      const id = `acct-${i}`;
      for (let v = 1; v <= K; v += 1) {
        await accountService.executeCommand(id, { type: 'DepositMoney', amountCents: 100 }, v);
      }
    }),
  );

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
      console.log(`MISMATCH ${row.aggregateId}: projection(balance=${row.balanceCents}, v=${row.version}) independent(balance=${want.balanceCents}, v=${want.version})`);
    }
  }
  const expectedTotal = N * K * 100;
  console.log(JSON.stringify({
    accounts: status.accounts.length,
    eventTotal: events.length,
    lastProcessedSeq: status.lastProcessedSeq,
    projectionTotal: status.summary.totalBalanceCents,
    expectedTotal,
    lag: status.lagEvents,
    caughtUp: status.caughtUp,
    processedEvents: status.processedEvents,
    mismatches,
  }, null, 2));

  await pool.end();
  process.exit(mismatches === 0 ? 0 : 2);
}

main().catch((e) => { console.error(e); process.exit(1); });
