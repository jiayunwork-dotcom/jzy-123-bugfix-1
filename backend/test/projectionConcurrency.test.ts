import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AccountProjection } from '../src/projections/accountProjection.js';
import { evolveAccount, initialAccountState, type AccountEvent, type AccountState } from '../src/domain/account.js';
import { setupTestDeps, teardownTestDeps, type TestDeps } from './helpers.js';

let deps: TestDeps;

beforeEach(async () => {
  deps = await setupTestDeps();
});

afterAll(async () => {
  if (deps) await teardownTestDeps(deps);
});

/** 不经过投影、直接用领域折叠函数按聚合事件流独立算出的"期望读模型" */
async function independentModel(): Promise<Map<string, AccountState & { version: number }>> {
  const events = await deps.eventStore.loadAllEvents();
  const model = new Map<string, AccountState & { version: number }>();
  for (const e of events) {
    const prev = model.get(e.aggregateId) ?? { ...initialAccountState, version: 0 };
    const next = evolveAccount(prev, e as unknown as AccountEvent);
    model.set(e.aggregateId, { ...next, version: e.version });
  }
  return model;
}

/** 逐字段比较增量读模型与独立回放结果（不做任何重放） */
async function expectIncrementalMatchesIndependentReplay(): Promise<void> {
  const status = await deps.projection.status();
  const expected = await independentModel();

  expect(status.accounts).toHaveLength(expected.size);
  for (const row of status.accounts) {
    const want = expected.get(row.aggregateId);
    expect(want, `missing expected row for ${row.aggregateId}`).toBeDefined();
    expect(row.owner, `${row.aggregateId} owner`).toBe(want!.owner);
    expect(row.balanceCents, `${row.aggregateId} balance`).toBe(want!.balanceCents);
    expect(row.version, `${row.aggregateId} version`).toBe(want!.version);
  }
  const total = [...expected.values()].reduce((s, a) => s + a.balanceCents, 0);
  expect(status.summary.totalBalanceCents).toBe(total);
  expect(status.summary.totalAccounts).toBe(expected.size);
  expect(status.caughtUp).toBe(true);
  expect(status.lagEvents).toBe(0);
  expect(status.processedEvents).toBe(status.eventTotal);
}

describe('投影增量消费：多账户并发写入后与独立回放逐字段一致（真实 PostgreSQL）', () => {
  it.each([
    { accounts: 40, deposits: 25 },
    { accounts: 12, deposits: 60 },
  ])(
    '$accounts 个账户并发、每户串行 $deposits 笔：增量读模型 ≡ 各账户事件流独立回放',
    async ({ accounts, deposits }) => {
      // 先开账户（全部初始余额 0）
      await Promise.all(
        Array.from({ length: accounts }, (_, i) =>
          deps.accountService.executeCommand(
            `acct-${i}`,
            { type: 'CreateAccount', owner: `owner-${i}` },
            0,
          ),
        ),
      );

      // 所有账户同时开跑；每个账户内部一笔等上一笔返回再发下一笔（不会有版本冲突）
      const results = await Promise.allSettled(
        Array.from({ length: accounts }, async (_, i) => {
          const id = `acct-${i}`;
          for (let v = 1; v <= deposits; v += 1) {
            const res = await deps.accountService.executeCommand(
              id,
              { type: 'DepositMoney', amountCents: 100 },
              v,
            );
            expect(res.version).toBe(v + 1);
          }
        }),
      );
      expect(results.every((r) => r.status === 'fulfilled')).toBe(true);

      // 关键验收：不做全量重放，直接逐字段对账
      await expectIncrementalMatchesIndependentReplay();

      // 再跑一次全量重放，业务字段必须不变（增量 ≡ 重放 的老不变量在新消费模型下依旧成立；
      // updatedAt 是重放时刻的时间戳，不参与逐字段对账）
      const stripTimestamps = (s: { accounts: Array<{ updatedAt?: string }> }) =>
        s.accounts.map(({ updatedAt: _updatedAt, ...rest }) => rest);
      const before = await deps.projection.status();
      await deps.projection.replay();
      const after = await deps.projection.status();
      expect(stripTimestamps(after)).toEqual(stripTimestamps(before));
      expect(after.summary).toEqual(before.summary);
      expect(after.lastProcessedSeq).toBe(before.lastProcessedSeq);
    },
  );

  it('写压过程中穿插全量重放：结束后（不再重放）增量消费依旧零漏事件', async () => {
    const accounts = 30;
    const deposits = 30;

    await Promise.all(
      Array.from({ length: accounts }, (_, i) =>
        deps.accountService.executeCommand(`acct-${i}`, { type: 'CreateAccount', owner: `o${i}` }, 0),
      ),
    );

    let writing = true;
    const replayer = (async () => {
      while (writing) {
        await new Promise((r) => setTimeout(r, 2));
        await deps.projection.replay();
      }
    })();

    await Promise.all(
      Array.from({ length: accounts }, async (_, i) => {
        const id = `acct-${i}`;
        for (let v = 1; v <= deposits; v += 1) {
          await deps.accountService.executeCommand(id, { type: 'DepositMoney', amountCents: 100 }, v);
        }
      }),
    );
    writing = false;
    await replayer;

    // 最终只靠增量跟进收尾，然后逐字段对账
    await deps.projection.processNewEvents();
    await expectIncrementalMatchesIndependentReplay();
  });

  it('读模型落后时接口如实暴露：lagEvents>0 / caughtUp=false，跟进一次后恢复', async () => {
    // 绕过服务层（不触发写后跟进）直接写事件，制造"写模型领先、读模型落后"
    await deps.eventStore.append('acct-a', 'account', 0, [
      { eventType: 'AccountCreated', payload: { owner: 'alice', initialBalanceCents: 0 } },
    ]);
    await deps.eventStore.append('acct-a', 'account', 1, [
      { eventType: 'MoneyDeposited', payload: { amountCents: 500 } },
    ]);
    await deps.eventStore.append('acct-b', 'account', 0, [
      { eventType: 'AccountCreated', payload: { owner: 'bob', initialBalanceCents: 300 } },
    ]);

    const lagging = await deps.projection.status();
    expect(lagging.eventTotal).toBe(3);
    expect(lagging.processedEvents).toBe(0);
    expect(lagging.lagEvents).toBe(3);
    expect(lagging.caughtUp).toBe(false);

    const applied = await deps.projection.processNewEvents();
    expect(applied).toBe(3);
    const caughtUp = await deps.projection.status();
    expect(caughtUp.lagEvents).toBe(0);
    expect(caughtUp.caughtUp).toBe(true);

    // 跟进失败（事务回滚）时不能谎报追平：让消费过程中的一条 SQL 必然失败
    const failingStore = Object.create(deps.eventStore) as typeof deps.eventStore;
    (failingStore as unknown as { listLaggingStreams: unknown }).listLaggingStreams = async () => {
      throw new Error('simulated projection failure');
    };
    const rebroken = new AccountProjection(deps.pool, failingStore);
    await expect(rebroken.processNewEvents()).rejects.toThrow('simulated projection failure');
    // 失败的跟进不得推进任何位点
    await deps.eventStore.append('acct-a', 'account', 2, [
      { eventType: 'MoneyDeposited', payload: { amountCents: 7 } },
    ]);
    const behind = await deps.projection.status();
    expect(behind.eventTotal).toBe(4);
    expect(behind.processedEvents).toBe(3);
    expect(behind.lagEvents).toBe(1);
    expect(behind.caughtUp).toBe(false);

    await deps.projection.processNewEvents();
    const finalStatus = await deps.projection.status();
    expect(finalStatus.caughtUp).toBe(true);
    expect(finalStatus.accounts.find((a) => a.aggregateId === 'acct-a')?.balanceCents).toBe(507);
  });

  it('模拟服务重启：位点持久化，重启后只补增量且结果与独立回放一致', async () => {
    const accounts = 15;
    const deposits = 20;

    await Promise.all(
      Array.from({ length: accounts }, (_, i) =>
        deps.accountService.executeCommand(`acct-${i}`, { type: 'CreateAccount', owner: `o${i}` }, 0),
      ),
    );
    await Promise.all(
      Array.from({ length: accounts }, async (_, i) => {
        const id = `acct-${i}`;
        for (let v = 1; v <= deposits; v += 1) {
          await deps.accountService.executeCommand(id, { type: 'DepositMoney', amountCents: 100 }, v);
        }
      }),
    );
    const before = await deps.projection.status();
    expect(before.caughtUp).toBe(true);
    const processedBefore = before.processedEvents;

    // "重启"：丢掉内存里的投影/服务对象、用同一个库重建依赖（位点全部来自持久化表）
    const { EventStore } = await import('../src/events/eventStore.js');
    const { AccountProjection } = await import('../src/projections/accountProjection.js');
    const pool = deps.pool;
    const restartedStore = new EventStore(pool);
    const restartedProjection = new AccountProjection(pool, restartedStore);

    // 重启期间又写进来的事件
    await restartedStore.append('acct-0', 'account', deposits + 1, [
      { eventType: 'MoneyDeposited', payload: { amountCents: 999 } },
    ]);
    const restartLag = await restartedProjection.status();
    expect(restartLag.caughtUp).toBe(false);
    expect(restartLag.lagEvents).toBe(1);
    expect(restartLag.processedEvents).toBe(processedBefore);

    // 启动时的增量跟进必须补齐且不重放
    await restartedProjection.processNewEvents();
    const model = await independentModel();
    const status = await restartedProjection.status();
    for (const row of status.accounts) {
      const want = model.get(row.aggregateId)!;
      expect(row.balanceCents).toBe(want.balanceCents);
      expect(row.version).toBe(want.version);
    }
    expect(status.summary.totalBalanceCents).toBe(
      [...model.values()].reduce((s, a) => s + a.balanceCents, 0),
    );
  });
});
