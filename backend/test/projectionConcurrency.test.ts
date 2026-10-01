import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import {
  evolveAccount,
  initialAccountState,
  type AccountEvent,
  type AccountState,
} from '../src/domain/account.js';
import { setupTestDeps, teardownTestDeps, type TestDeps } from './helpers.js';
import { TEST_DATABASE_URL } from './globalSetup.js';

let deps: TestDeps;

beforeEach(async () => {
  deps = await setupTestDeps();
});

afterAll(async () => {
  if (deps) await teardownTestDeps(deps);
});

/** 不经过投影、逐账户按事件流独立回放得到的期望读模型（金额 + 版本 + 账户数 + 汇总） */
async function independentReplay(): Promise<{
  rows: Map<string, { owner: string; balanceCents: number; version: number }>;
  totalBalance: number;
}> {
  // 直接按聚合登记表里的每个账户回放，避免依赖 global_seq
  const aggregates = await deps.eventStore.listAggregates();
  const rows = new Map<string, { owner: string; balanceCents: number; version: number }>();
  let totalBalance = 0;
  for (const { aggregateId } of aggregates) {
    const events = await deps.eventStore.loadEvents(aggregateId);
    let state: AccountState = initialAccountState;
    let version = 0;
    for (const e of events) {
      state = evolveAccount(state, e as unknown as AccountEvent);
      version = e.version;
    }
    rows.set(aggregateId, { owner: state.owner ?? '', balanceCents: state.balanceCents, version });
    totalBalance += state.balanceCents;
  }
  return { rows, totalBalance };
}

/** 断言增量读模型与独立回放逐字段一致（不做任何重放） */
async function expectProjectionMatchesIndependentReplay() {
  const status = await deps.projection.status();
  const expected = await independentReplay();

  expect(status.summary.totalAccounts).toBe(expected.rows.size);
  expect(status.accounts).toHaveLength(expected.rows.size);

  for (const row of status.accounts) {
    const want = expected.rows.get(row.aggregateId);
    expect(want, `读模型里多出来的账户: ${row.aggregateId}`).toBeDefined();
    expect(row.owner, `${row.aggregateId} owner`).toBe(want!.owner);
    expect(row.balanceCents, `${row.aggregateId} balance`).toBe(want!.balanceCents);
    expect(row.version, `${row.aggregateId} version`).toBe(want!.version);
  }
  expect(status.summary.totalBalanceCents).toBe(expected.totalBalance);
  return status;
}

describe('增量消费不丢事件（真实 PostgreSQL，多账户并发写入）', () => {
  it('40 个账户并发、每户串行 25 笔存款：不重放，读模型逐账户逐字段等于独立回放', async () => {
    const ACCOUNT_COUNT = 40;
    const DEPOSITS = 25;

    // 每个账户内部严格"上一笔返回再发下一笔"，因此同账户永不发生版本冲突；
    // 40 个账户同时开跑，制造大量跨聚合并发提交。
    async function runAccount(i: number) {
      const id = `acct-${i}`;
      await deps.accountService.executeCommand(
        id,
        { type: 'CreateAccount', owner: `user-${i}` },
        0,
      );
      let version = 1;
      for (let d = 0; d < DEPOSITS; d += 1) {
        await deps.accountService.executeCommand(id, { type: 'DepositMoney', amountCents: 100 }, version);
        version += 1;
      }
    }

    await Promise.all(Array.from({ length: ACCOUNT_COUNT }, (_, i) => runAccount(i)));

    // 不做任何全量重放，直接比对
    const status = await expectProjectionMatchesIndependentReplay();
    expect(status.summary.totalBalanceCents).toBe(ACCOUNT_COUNT * DEPOSITS * 100);
    for (const row of status.accounts) expect(row.version).toBe(DEPOSITS + 1);
    expect(status.caughtUp).toBe(true);
    expect(status.lagEvents).toBe(0);
    expect(status.laggingStreams).toEqual([]);
  });

  it('加大规模（80 账户 × 40 笔）结论不变', async () => {
    const ACCOUNT_COUNT = 80;
    const DEPOSITS = 40;

    async function runAccount(i: number) {
      const id = `big-${i}`;
      await deps.accountService.executeCommand(id, { type: 'CreateAccount', owner: `u${i}` }, 0);
      let version = 1;
      for (let d = 0; d < DEPOSITS; d += 1) {
        await deps.accountService.executeCommand(id, { type: 'DepositMoney', amountCents: 100 }, version);
        version += 1;
      }
    }

    await Promise.all(Array.from({ length: ACCOUNT_COUNT }, (_, i) => runAccount(i)));

    const status = await expectProjectionMatchesIndependentReplay();
    expect(status.summary.totalBalanceCents).toBe(ACCOUNT_COUNT * DEPOSITS * 100);
  });

  it('服务重启等价场景：清空投影实例、用同一个库新建实例（检查点从数据库恢复），继续写入后仍一致', async () => {
    // 前半段用原实例并发写入
    async function runAccount(i: number, deposits: number) {
      const id = `restart-${i}`;
      await deps.accountService.executeCommand(id, { type: 'CreateAccount', owner: `r${i}` }, 0);
      let version = 1;
      for (let d = 0; d < deposits; d += 1) {
        await deps.accountService.executeCommand(id, { type: 'DepositMoney', amountCents: 10 }, version);
        version += 1;
      }
    }
    await Promise.all(Array.from({ length: 20 }, (_, i) => runAccount(i, 10)));

    // 模拟进程重启：内存状态全部丢弃，只凭数据库里的检查点重建投影实例
    const { AccountProjection } = await import('../src/projections/accountProjection.js');
    const { AccountService } = await import('../src/aggregates/accountService.js');
    const restartedPool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 10 });
    const restartedProjection = new AccountProjection(restartedPool, deps.eventStore);
    const restartedService = new AccountService(deps.eventStore, deps.snapshotStore, restartedProjection);

    // 重启后再并发写后半段（沿用部分旧账户 + 新账户）
    async function runMore(i: number) {
      const id = `restart-${i}`;
      let version = 11; // 前半段每户 10 笔 + create
      for (let d = 0; d < 10; d += 1) {
        await restartedService.executeCommand(id, { type: 'DepositMoney', amountCents: 10 }, version);
        version += 1;
      }
    }
    await Promise.all(Array.from({ length: 20 }, (_, i) => runMore(i)));

    await expectProjectionMatchesIndependentReplay();
    await restartedPool.end();
  });
});

describe('全量重放与增量消费的等价性 / 并发性', () => {
  it('压测中途插入一次全量重放：重放结束后的增量消费不漏事件，终态逐字段相等', async () => {
    const ACCOUNT_COUNT = 30;
    const DEPOSITS = 30;
    let replayTriggered = false;

    async function runAccount(i: number) {
      const id = `rp-${i}`;
      await deps.accountService.executeCommand(id, { type: 'CreateAccount', owner: `p${i}` }, 0);
      let version = 1;
      for (let d = 0; d < DEPOSITS; d += 1) {
        await deps.accountService.executeCommand(id, { type: 'DepositMoney', amountCents: 100 }, version);
        version += 1;
        // 在写入进行到约一半时，由"另一个操作者"触发一次全量重放（只触发一次）
        if (!replayTriggered && d === Math.floor(DEPOSITS / 2)) {
          replayTriggered = true;
          await deps.projection.replay();
        }
      }
    }

    await Promise.all(Array.from({ length: ACCOUNT_COUNT }, (_, i) => runAccount(i)));
    expect(replayTriggered).toBe(true);

    const status = await expectProjectionMatchesIndependentReplay();
    expect(status.summary.totalBalanceCents).toBe(ACCOUNT_COUNT * DEPOSITS * 100);

    // 再做一次全量重放，结果必须与增量终态完全一致
    await deps.projection.replay();
    await expectProjectionMatchesIndependentReplay();
  });

  it('重放与大量写入严格并发（交错开始）也不丢不重', async () => {
    const ACCOUNT_COUNT = 25;

    async function runAccount(i: number) {
      const id = `ix-${i}`;
      await deps.accountService.executeCommand(id, { type: 'CreateAccount', owner: `x${i}` }, 0);
      let version = 1;
      for (let d = 0; d < 20; d += 1) {
        await deps.accountService.executeCommand(id, { type: 'DepositMoney', amountCents: 5 }, version);
        version += 1;
      }
    }

    const writers = Promise.all(Array.from({ length: ACCOUNT_COUNT }, (_, i) => runAccount(i)));
    // 写入进行中启动重放，两者互斥但都必须成功
    await new Promise((resolve) => setTimeout(resolve, 15));
    const replay = deps.projection.replay();
    await Promise.all([writers, replay]);

    await expectProjectionMatchesIndependentReplay();
  });
});

describe('读模型滞后可从接口观测', () => {
  it('增量跟进失败/未执行时，状态接口如实报落后，而不是虚报追平的序号', async () => {
    // 直接走 eventStore 追加（绕过服务层的投影跟进），模拟"事件已落库、读模型没跟上"
    await deps.eventStore.append('lag-1', 'account', 0, [
      { eventType: 'AccountCreated', payload: { owner: 'laggy', initialBalanceCents: 0 } },
    ]);
    await deps.eventStore.append('lag-1', 'account', 1, [
      { eventType: 'MoneyDeposited', payload: { amountCents: 700 } },
    ]);
    await deps.eventStore.append('lag-2', 'account', 0, [
      { eventType: 'AccountCreated', payload: { owner: 'other', initialBalanceCents: 0 } },
    ]);

    const lagged = await deps.projection.status();
    expect(lagged.accounts).toEqual([]);
    expect(lagged.caughtUp).toBe(false);
    expect(lagged.lagEvents).toBe(3);
    expect(lagged.laggingStreams).toHaveLength(2);
    const stream1 = lagged.laggingStreams.find((s) => s.aggregateId === 'lag-1')!;
    expect(stream1).toMatchObject({ currentVersion: 2, processedVersion: 0, lagEvents: 2 });
    // 水位不能虚报成写侧最新 seq：第 1 条事件尚未消费，水位必须停在 0
    expect(lagged.lastProcessedSeq).toBe(0);
    expect(lagged.latestGlobalSeq).toBe(3);

    // 跟进一次后追平
    expect(await deps.projection.processNewEvents()).toBe(3);
    const caught = await deps.projection.status();
    expect(caught.caughtUp).toBe(true);
    expect(caught.lagEvents).toBe(0);
    expect(caught.laggingStreams).toEqual([]);
    expect(caught.lastProcessedSeq).toBe(3);
  });

  it('有事务提交中（更小 seq 尚不可见）时，水位只推进到确定完整的位置', async () => {
    const pool = deps.pool as pg.Pool;
    // 先提交一条事件并让投影消费
    await deps.accountService.executeCommand('w-1', { type: 'CreateAccount', owner: 'w' }, 0);
    // 手工开一个"挂起不提交"的事务写入下一条事件，模拟提交中的写入
    const holder = await pool.connect();
    await holder.query('BEGIN');
    await holder.query(
      `INSERT INTO aggregates (aggregate_id, aggregate_type, current_version) VALUES ('w-2','account',0)
       ON CONFLICT DO NOTHING`,
    );
    await holder.query(
      `INSERT INTO events (aggregate_id, aggregate_type, version, event_type, payload)
       VALUES ('w-2','account',1,'AccountCreated','{"owner":"w2","initialBalanceCents":0}'::jsonb)`,
    );
    try {
      // 另一个连接提交一条更大 seq 的事件：旧逻辑会让水位越过未提交的小 seq
      await deps.accountService.executeCommand('w-3', { type: 'CreateAccount', owner: 'w3' }, 0);

      const status = await deps.projection.status();
      // 未提交的 w-2 占着 seq 2（不可见），w-3 的 seq 3 已提交并已消费。
      // 保守水位必须停在未提交事件之前（1），绝不能虚报成写侧最新 seq 3。
      expect(status.lastProcessedSeq).toBe(1);
      expect(status.latestGlobalSeq).toBe(3);
      // w-2 尚未提交，不计入"已提交未消费"的滞后；水位单独暴露了在途写入。
      expect(status.lagEvents).toBe(0);
      // w-2 一旦提交，增量消费必须把它补回来（不会被永久跳过）
    } finally {
      await holder.query('COMMIT');
      holder.release();
    }

    await deps.projection.processNewEvents();
    const final = await deps.projection.status();
    const w2 = final.accounts.find((a) => a.aggregateId === 'w-2');
    expect(w2).toBeDefined();
    expect(w2!.version).toBe(1);
    expect(final.caughtUp).toBe(true);
    await expectProjectionMatchesIndependentReplay();
  });
});
