import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ACCOUNT_AGGREGATE_TYPE } from '../src/domain/account.js';
import { AppError } from '../src/errors.js';
import { setupTestDeps, teardownTestDeps, resetDatabase, type TestDeps } from './helpers.js';

let deps: TestDeps;

beforeEach(async () => {
  deps = await setupTestDeps();
});

afterAll(async () => {
  if (deps) await teardownTestDeps(deps);
});

describe('事件存储：追加与版本号', () => {
  it('expectedVersion=0 的首次追加视为创建聚合，首条事件版本为 1', async () => {
    const stored = await deps.eventStore.append('acct-1', ACCOUNT_AGGREGATE_TYPE, 0, [
      { eventType: 'AccountCreated', payload: { owner: 'alice', initialBalanceCents: 0 } },
    ]);
    expect(stored).toHaveLength(1);
    expect(stored[0].version).toBe(1);
    expect(stored[0].aggregateId).toBe('acct-1');
    expect(await deps.eventStore.getCurrentVersion('acct-1')).toBe(1);
  });

  it('连续追加时版本号严格递增且无空洞', async () => {
    await deps.eventStore.append('acct-1', ACCOUNT_AGGREGATE_TYPE, 0, [
      { eventType: 'AccountCreated', payload: { owner: 'alice', initialBalanceCents: 100 } },
      { eventType: 'MoneyDeposited', payload: { amountCents: 50 } },
    ]);
    const second = await deps.eventStore.append('acct-1', ACCOUNT_AGGREGATE_TYPE, 2, [
      { eventType: 'MoneyDeposited', payload: { amountCents: 1 } },
      { eventType: 'MoneyWithdrawn', payload: { amountCents: 2 } },
      { eventType: 'MoneyDeposited', payload: { amountCents: 3 } },
    ]);
    expect(second.map((e) => e.version)).toEqual([3, 4, 5]);

    const all = await deps.eventStore.loadEvents('acct-1');
    expect(all.map((e) => e.version)).toEqual([1, 2, 3, 4, 5]);
    // 全局序号同样严格递增
    const seqs = all.map((e) => e.globalSeq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    expect(await deps.eventStore.getCurrentVersion('acct-1')).toBe(5);
  });

  it('expectedVersion 与服务端当前版本不符 → VERSION_CONFLICT，且不写入任何事件', async () => {
    await deps.eventStore.append('acct-1', ACCOUNT_AGGREGATE_TYPE, 0, [
      { eventType: 'AccountCreated', payload: { owner: 'alice', initialBalanceCents: 0 } },
    ]);
    const err = await deps.eventStore
      .append('acct-1', ACCOUNT_AGGREGATE_TYPE, 0, [
        { eventType: 'MoneyDeposited', payload: { amountCents: 1 } },
      ])
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('VERSION_CONFLICT');
    expect((err as AppError).httpStatus).toBe(409);
    expect((err as AppError).details).toMatchObject({ expectedVersion: 0, actualVersion: 1 });
    // 冲突的追加必须整体回滚
    expect(await deps.eventStore.getCurrentVersion('acct-1')).toBe(1);
    expect(await deps.eventStore.loadEvents('acct-1')).toHaveLength(1);
  });

  it('对不存在的聚合：expectedVersion>0 明确拒绝（AGGREGATE_NOT_FOUND）', async () => {
    const err = await deps.eventStore
      .append('ghost', ACCOUNT_AGGREGATE_TYPE, 3, [
        { eventType: 'MoneyDeposited', payload: { amountCents: 1 } },
      ])
      .catch((e: unknown) => e);
    expect((err as AppError).code).toBe('AGGREGATE_NOT_FOUND');
    expect((err as AppError).httpStatus).toBe(404);
    expect(await deps.eventStore.getCurrentVersion('ghost')).toBeNull();
  });

  it('聚合类型不匹配 → VALIDATION_FAILED', async () => {
    await deps.eventStore.append('acct-1', ACCOUNT_AGGREGATE_TYPE, 0, [
      { eventType: 'AccountCreated', payload: { owner: 'a', initialBalanceCents: 0 } },
    ]);
    const err = await deps.eventStore
      .append('acct-1', 'order', 1, [{ eventType: 'X', payload: {} }])
      .catch((e: unknown) => e);
    expect((err as AppError).code).toBe('VALIDATION_FAILED');
  });

  it('非法入参：空事件列表 / 负的 expectedVersion / 空事件类型', async () => {
    for (const bad of [
      () => deps.eventStore.append('a', ACCOUNT_AGGREGATE_TYPE, 0, []),
      () => deps.eventStore.append('a', ACCOUNT_AGGREGATE_TYPE, -1, [{ eventType: 'X', payload: {} }]),
      () => deps.eventStore.append('a', ACCOUNT_AGGREGATE_TYPE, 0, [{ eventType: '', payload: {} }]),
    ]) {
      const err = await bad().catch((e: unknown) => e);
      expect((err as AppError).code).toBe('VALIDATION_FAILED');
    }
  });
});

describe('事件存储：按版本区间读取', () => {
  beforeEach(async () => {
    await deps.eventStore.append('acct-1', ACCOUNT_AGGREGATE_TYPE, 0, [
      { eventType: 'AccountCreated', payload: { owner: 'alice', initialBalanceCents: 0 } },
    ]);
    await deps.eventStore.append('acct-1', ACCOUNT_AGGREGATE_TYPE, 1, [
      { eventType: 'MoneyDeposited', payload: { amountCents: 10 } },
      { eventType: 'MoneyWithdrawn', payload: { amountCents: 5 } },
      { eventType: 'MoneyDeposited', payload: { amountCents: 20 } },
    ]);
  });

  it('取出完整事件序列（默认从 1 到最新）', async () => {
    const events = await deps.eventStore.loadEvents('acct-1');
    expect(events.map((e) => e.version)).toEqual([1, 2, 3, 4]);
    expect(events.map((e) => e.eventType)).toEqual([
      'AccountCreated',
      'MoneyDeposited',
      'MoneyWithdrawn',
      'MoneyDeposited',
    ]);
  });

  it('按 [fromVersion, toVersion] 区间切片', async () => {
    const slice = await deps.eventStore.loadEvents('acct-1', 2, 3);
    expect(slice.map((e) => e.version)).toEqual([2, 3]);
  });

  it('区间上界超出当前版本时截断到当前版本', async () => {
    const slice = await deps.eventStore.loadEvents('acct-1', 3, 999);
    expect(slice.map((e) => e.version)).toEqual([3, 4]);
  });

  it('对不存在的聚合读取 → AGGREGATE_NOT_FOUND', async () => {
    const err = await deps.eventStore.loadEvents('ghost').catch((e: unknown) => e);
    expect((err as AppError).code).toBe('AGGREGATE_NOT_FOUND');
  });

  it('非法区间参数 → VALIDATION_FAILED', async () => {
    const err1 = await deps.eventStore.loadEvents('acct-1', 0).catch((e: unknown) => e);
    expect((err1 as AppError).code).toBe('VALIDATION_FAILED');
    const err2 = await deps.eventStore.loadEvents('acct-1', 3, 2).catch((e: unknown) => e);
    expect((err2 as AppError).code).toBe('VALIDATION_FAILED');
  });
});
