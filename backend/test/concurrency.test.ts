import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ACCOUNT_AGGREGATE_TYPE } from '../src/domain/account.js';
import { AppError } from '../src/errors.js';
import { setupTestDeps, teardownTestDeps, type TestDeps } from './helpers.js';

let deps: TestDeps;

beforeEach(async () => {
  deps = await setupTestDeps();
});

afterAll(async () => {
  if (deps) await teardownTestDeps(deps);
});

describe('并发版本控制（乐观并发）', () => {
  it('同一聚合、同一 expectedVersion 的并发追加：只有一条成功，其余全部 VERSION_CONFLICT', async () => {
    // 先建聚合，当前版本 1
    await deps.eventStore.append('acct-1', ACCOUNT_AGGREGATE_TYPE, 0, [
      { eventType: 'AccountCreated', payload: { owner: 'alice', initialBalanceCents: 0 } },
    ]);

    // 5 个并发写入都声称基于版本 1
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) =>
        deps.eventStore.append('acct-1', ACCOUNT_AGGREGATE_TYPE, 1, [
          { eventType: 'MoneyDeposited', payload: { amountCents: i + 1 } },
        ]),
      ),
    );

    const succeeded = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');

    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(4);
    for (const f of failed) {
      expect((f as PromiseRejectedResult).reason).toBeInstanceOf(AppError);
      expect(((f as PromiseRejectedResult).reason as AppError).code).toBe('VERSION_CONFLICT');
    }

    // 最终只追加了一条事件：版本 2，事件流连续无分叉
    expect(await deps.eventStore.getCurrentVersion('acct-1')).toBe(2);
    const events = await deps.eventStore.loadEvents('acct-1');
    expect(events.map((e) => e.version)).toEqual([1, 2]);
  });

  it('两个客户端并发创建同一聚合（expectedVersion=0）：只有一个创建成功', async () => {
    const results = await Promise.allSettled([
      deps.eventStore.append('acct-race', ACCOUNT_AGGREGATE_TYPE, 0, [
        { eventType: 'AccountCreated', payload: { owner: 'alice', initialBalanceCents: 0 } },
      ]),
      deps.eventStore.append('acct-race', ACCOUNT_AGGREGATE_TYPE, 0, [
        { eventType: 'AccountCreated', payload: { owner: 'bob', initialBalanceCents: 0 } },
      ]),
    ]);
    const succeeded = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(((failed[0] as PromiseRejectedResult).reason as AppError).code).toBe('VERSION_CONFLICT');
    expect(await deps.eventStore.getCurrentVersion('acct-race')).toBe(1);
  });

  it('追加成功后，旧的 expectedVersion 立即失效', async () => {
    await deps.eventStore.append('acct-1', ACCOUNT_AGGREGATE_TYPE, 0, [
      { eventType: 'AccountCreated', payload: { owner: 'alice', initialBalanceCents: 0 } },
    ]);
    await deps.eventStore.append('acct-1', ACCOUNT_AGGREGATE_TYPE, 1, [
      { eventType: 'MoneyDeposited', payload: { amountCents: 10 } },
    ]);
    const err = await deps.eventStore
      .append('acct-1', ACCOUNT_AGGREGATE_TYPE, 1, [
        { eventType: 'MoneyDeposited', payload: { amountCents: 10 } },
      ])
      .catch((e: unknown) => e);
    expect((err as AppError).code).toBe('VERSION_CONFLICT');
    expect((err as AppError).details).toMatchObject({ expectedVersion: 1, actualVersion: 2 });
  });

  it('不同聚合之间的并发追加互不影响', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) =>
        deps.eventStore.append(`acct-${i}`, ACCOUNT_AGGREGATE_TYPE, 0, [
          { eventType: 'AccountCreated', payload: { owner: `u${i}`, initialBalanceCents: i } },
        ]),
      ),
    );
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    for (let i = 0; i < 6; i += 1) {
      expect(await deps.eventStore.getCurrentVersion(`acct-${i}`)).toBe(1);
    }
  });
});
