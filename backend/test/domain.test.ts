import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../src/errors.js';
import { setupTestDeps, teardownTestDeps, type TestDeps } from './helpers.js';

let deps: TestDeps;

beforeEach(async () => {
  deps = await setupTestDeps();
});

afterAll(async () => {
  if (deps) await teardownTestDeps(deps);
});

/** 断言一次失败的命令没有产生任何事件 */
async function expectNoEvent(aggregateId: string): Promise<void> {
  expect(await deps.eventStore.getCurrentVersion(aggregateId)).toBeNull();
}

describe('业务校验：不合法的命令不产生事件', () => {
  it('余额不能被取成负数：超额取款报 INSUFFICIENT_FUNDS，且不产生事件', async () => {
    await deps.accountService.executeCommand('acct-1', { type: 'CreateAccount', owner: 'alice', initialBalanceCents: 100 }, 0);

    const err = await deps.accountService
      .executeCommand('acct-1', { type: 'WithdrawMoney', amountCents: 101 }, 1)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('INSUFFICIENT_FUNDS');
    expect((err as AppError).httpStatus).toBe(422);

    // 版本停在 1，事件流里只有创建事件
    expect(await deps.eventStore.getCurrentVersion('acct-1')).toBe(1);
    const events = await deps.eventStore.loadEvents('acct-1');
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('AccountCreated');
  });

  it('恰好取空余额是合法的', async () => {
    await deps.accountService.executeCommand('acct-1', { type: 'CreateAccount', owner: 'alice', initialBalanceCents: 100 }, 0);
    const result = await deps.accountService.executeCommand('acct-1', { type: 'WithdrawMoney', amountCents: 100 }, 1);
    expect(result.state.balanceCents).toBe(0);
  });

  it('零 / 负数 / 非整数金额被拒绝，且不产生事件', async () => {
    await deps.accountService.executeCommand('acct-1', { type: 'CreateAccount', owner: 'alice', initialBalanceCents: 100 }, 0);
    for (const amountCents of [0, -5, 1.5, Number.NaN]) {
      const err = await deps.accountService
        .executeCommand('acct-1', { type: 'DepositMoney', amountCents }, 1)
        .catch((e: unknown) => e);
      expect((err as AppError).code).toBe('VALIDATION_FAILED');
      const err2 = await deps.accountService
        .executeCommand('acct-1', { type: 'WithdrawMoney', amountCents }, 1)
        .catch((e: unknown) => e);
      expect((err2 as AppError).code).toBe('VALIDATION_FAILED');
    }
    expect(await deps.eventStore.getCurrentVersion('acct-1')).toBe(1);
  });

  it('对不存在的账户存款 / 取款 → AGGREGATE_NOT_FOUND，且不会顺手创建聚合', async () => {
    const err1 = await deps.accountService
      .executeCommand('ghost', { type: 'DepositMoney', amountCents: 100 }, 0)
      .catch((e: unknown) => e);
    expect((err1 as AppError).code).toBe('AGGREGATE_NOT_FOUND');
    const err2 = await deps.accountService
      .executeCommand('ghost', { type: 'WithdrawMoney', amountCents: 100 }, 0)
      .catch((e: unknown) => e);
    expect((err2 as AppError).code).toBe('AGGREGATE_NOT_FOUND');
    await expectNoEvent('ghost');
  });

  it('重复创建同一账户 → AGGREGATE_ALREADY_EXISTS', async () => {
    await deps.accountService.executeCommand('acct-1', { type: 'CreateAccount', owner: 'alice' }, 0);
    const err = await deps.accountService
      .executeCommand('acct-1', { type: 'CreateAccount', owner: 'alice' }, 1)
      .catch((e: unknown) => e);
    expect((err as AppError).code).toBe('AGGREGATE_ALREADY_EXISTS');
    expect((err as AppError).httpStatus).toBe(409);
    expect(await deps.eventStore.getCurrentVersion('acct-1')).toBe(1);
  });

  it('初始余额为负 / 户主为空 → VALIDATION_FAILED，聚合不会被创建', async () => {
    const err1 = await deps.accountService
      .executeCommand('acct-1', { type: 'CreateAccount', owner: 'alice', initialBalanceCents: -1 }, 0)
      .catch((e: unknown) => e);
    expect((err1 as AppError).code).toBe('VALIDATION_FAILED');
    const err2 = await deps.accountService
      .executeCommand('acct-2', { type: 'CreateAccount', owner: '  ' }, 0)
      .catch((e: unknown) => e);
    expect((err2 as AppError).code).toBe('VALIDATION_FAILED');
    await expectNoEvent('acct-1');
    await expectNoEvent('acct-2');
  });
});
