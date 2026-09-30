import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  evolveAccount,
  initialAccountState,
  type AccountEvent,
  type AccountState,
} from '../src/domain/account.js';
import { setupTestDeps, teardownTestDeps, type TestDeps } from './helpers.js';

let deps: TestDeps;

beforeEach(async () => {
  deps = await setupTestDeps();
});

afterAll(async () => {
  if (deps) await teardownTestDeps(deps);
});

/** 通过服务层写入一组账户事件（每次写入后都会触发投影的增量消费） */
async function seedEvents(): Promise<void> {
  await deps.accountService.executeCommand('acct-a', { type: 'CreateAccount', owner: 'alice', initialBalanceCents: 10_000 }, 0);
  await deps.accountService.executeCommand('acct-b', { type: 'CreateAccount', owner: 'bob', initialBalanceCents: 5_000 }, 0);
  await deps.accountService.executeCommand('acct-a', { type: 'DepositMoney', amountCents: 2_500 }, 1);
  await deps.accountService.executeCommand('acct-b', { type: 'WithdrawMoney', amountCents: 1_200 }, 1);
  await deps.accountService.executeCommand('acct-a', { type: 'WithdrawMoney', amountCents: 3_000 }, 2);
  await deps.accountService.executeCommand('acct-c', { type: 'CreateAccount', owner: 'carol' }, 0);
  await deps.accountService.executeCommand('acct-c', { type: 'DepositMoney', amountCents: 700 }, 1);
  await deps.accountService.executeCommand('acct-b', { type: 'DepositMoney', amountCents: 100 }, 2);
}

/** 不经过投影、直接用领域折叠函数从事件流独立算出的"期望读模型" */
async function independentFold(): Promise<Map<string, AccountState & { version: number }>> {
  const events = await deps.eventStore.loadAllEvents();
  const model = new Map<string, AccountState & { version: number }>();
  for (const e of events) {
    const prev = model.get(e.aggregateId) ?? { ...initialAccountState, version: 0 };
    const next = evolveAccount(prev, e as unknown as AccountEvent);
    model.set(e.aggregateId, { ...next, version: e.version });
  }
  return model;
}

/** 读模型的业务字段（忽略 updatedAt 这类时间戳） */
function businessRows(status: { accounts: Array<{ aggregateId: string; owner: string; balanceCents: number; version: number }> }) {
  return status.accounts.map(({ aggregateId, owner, balanceCents, version }) => ({
    aggregateId,
    owner,
    balanceCents,
    version,
  }));
}

describe('投影一致性：全量重放 ≡ 增量消费（框架最要命的不变量）', () => {
  it('增量消费的结果与全量重放的结果完全一致', async () => {
    await seedEvents();

    // 1) 增量消费的结果（seedEvents 里每次写入后都增量跟进过）
    const incremental = await deps.projection.status();
    expect(incremental.accounts).toHaveLength(3);
    expect(incremental.lastProcessedSeq).toBe(8);

    // 2) 全量重放
    const replayResult = await deps.projection.replay();
    expect(replayResult.processedEvents).toBe(8);
    const replayed = await deps.projection.status();

    // 3) 两者逐字段一致
    expect(businessRows(replayed)).toEqual(businessRows(incremental));
    expect(replayed.summary).toEqual(incremental.summary);
    expect(replayed.lastProcessedSeq).toBe(incremental.lastProcessedSeq);
  });

  it('增量与重放的结果都等于用领域折叠函数独立算出的模型', async () => {
    await seedEvents();
    const expected = await independentFold();

    const incremental = await deps.projection.status();
    await deps.projection.replay();
    const replayed = await deps.projection.status();

    for (const status of [incremental, replayed]) {
      expect(status.accounts).toHaveLength(expected.size);
      for (const row of status.accounts) {
        const want = expected.get(row.aggregateId);
        expect(want, `missing expected row for ${row.aggregateId}`).toBeDefined();
        expect(row.owner).toBe(want!.owner);
        expect(row.balanceCents).toBe(want!.balanceCents);
        expect(row.version).toBe(want!.version);
      }
      const total = [...expected.values()].reduce((s, a) => s + a.balanceCents, 0);
      expect(status.summary.totalBalanceCents).toBe(total);
      expect(status.summary.totalAccounts).toBe(expected.size);
    }
  });

  it('重放是幂等的：连续重放多次结果不变', async () => {
    await seedEvents();
    await deps.projection.replay();
    const first = businessRows(await deps.projection.status());
    await deps.projection.replay();
    const second = businessRows(await deps.projection.status());
    expect(second).toEqual(first);
  });

  it('空事件流上重放得到空读模型', async () => {
    const { processedEvents } = await deps.projection.replay();
    expect(processedEvents).toBe(0);
    const status = await deps.projection.status();
    expect(status.accounts).toEqual([]);
    expect(status.summary).toEqual({ totalAccounts: 0, totalBalanceCents: 0 });
    expect(status.lastProcessedSeq).toBe(0);
  });

  it('重放之后增量消费能无缝接续（检查点正确推进）', async () => {
    await seedEvents();
    await deps.projection.replay();

    // 重放后再写新事件，增量消费只处理新增部分
    await deps.accountService.executeCommand('acct-a', { type: 'DepositMoney', amountCents: 1 }, 3);
    const status = await deps.projection.status();
    expect(status.lastProcessedSeq).toBe(9);
    const acctA = status.accounts.find((a) => a.aggregateId === 'acct-a');
    expect(acctA?.balanceCents).toBe(9_501);

    // 没有新事件时增量消费是空转
    expect(await deps.projection.processNewEvents()).toBe(0);
  });
});
