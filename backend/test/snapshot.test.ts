import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  evolveAccount,
  initialAccountState,
  type AccountEvent,
  type AccountState,
} from '../src/domain/account.js';
import { AppError } from '../src/errors.js';
import { setupTestDeps, teardownTestDeps, type TestDeps } from './helpers.js';

let deps: TestDeps;

beforeEach(async () => {
  deps = await setupTestDeps();
  // 造一个有多条事件的账户：v1 创建，v2..v6 存取混合
  await deps.accountService.executeCommand('acct-1', { type: 'CreateAccount', owner: 'alice', initialBalanceCents: 1000 }, 0);
  await deps.accountService.executeCommand('acct-1', { type: 'DepositMoney', amountCents: 500 }, 1);
  await deps.accountService.executeCommand('acct-1', { type: 'WithdrawMoney', amountCents: 200 }, 2);
  await deps.accountService.executeCommand('acct-1', { type: 'DepositMoney', amountCents: 50 }, 3);
  await deps.accountService.executeCommand('acct-1', { type: 'WithdrawMoney', amountCents: 100 }, 4);
  await deps.accountService.executeCommand('acct-1', { type: 'DepositMoney', amountCents: 750 }, 5);
});

afterAll(async () => {
  if (deps) await teardownTestDeps(deps);
});

/** 不依赖任何快照的"全量重放"基准：直接从事件流逐条折叠 */
async function fullReplayBaseline(aggregateId: string, toVersion?: number): Promise<AccountState> {
  const events = await deps.eventStore.loadEvents(aggregateId, 1, toVersion);
  return events.reduce<AccountState>(
    (state, e) => evolveAccount(state, e as unknown as AccountEvent),
    initialAccountState,
  );
}

describe('快照重建 ≡ 全量重放（逐字段相等）', () => {
  it('无快照时重建结果等于手工全量重放', async () => {
    const rebuilt = await deps.accountService.rebuild('acct-1');
    const baseline = await fullReplayBaseline('acct-1');
    expect(rebuilt.state).toEqual(baseline);
    expect(rebuilt.version).toBe(6);
    expect(rebuilt.snapshotUsed).toBeNull();
    expect(rebuilt.eventsApplied).toBe(6);
  });

  it('快照打在每个可能的版本上，重建结果都与全量重放逐字段相等', async () => {
    const baseline = await fullReplayBaseline('acct-1');
    for (let v = 1; v <= 6; v += 1) {
      await deps.accountService.createSnapshot('acct-1', v);
      const rebuilt = await deps.accountService.rebuild('acct-1');
      expect(rebuilt.state).toEqual(baseline);
      expect(rebuilt.version).toBe(6);
      expect(rebuilt.snapshotUsed).toEqual({ version: v });
      expect(rebuilt.eventsApplied).toBe(6 - v);
    }
  });

  it('存在快照时，重建任意中间版本的历史状态仍与全量重放到该版本一致', async () => {
    // 快照打在 v4，然后分别重建 v1..v6 的历史状态
    await deps.accountService.createSnapshot('acct-1', 4);
    for (let target = 1; target <= 6; target += 1) {
      const rebuilt = await deps.accountService.rebuild('acct-1', target);
      const baseline = await fullReplayBaseline('acct-1', target);
      expect(rebuilt.state).toEqual(baseline);
      expect(rebuilt.version).toBe(target);
    }
  });

  it('快照内容本身就是该版本的全量重放状态', async () => {
    for (const v of [1, 3, 6]) {
      const snapshot = await deps.accountService.createSnapshot('acct-1', v);
      const baseline = await fullReplayBaseline('acct-1', v);
      expect(snapshot.state).toEqual(baseline);
    }
  });

  it('打快照不改变事件流，也不影响后续追加', async () => {
    const before = await deps.eventStore.loadEvents('acct-1');
    await deps.accountService.createSnapshot('acct-1', 3);
    await deps.accountService.createSnapshot('acct-1', 6);
    const after = await deps.eventStore.loadEvents('acct-1');
    expect(after).toEqual(before);

    const result = await deps.accountService.executeCommand('acct-1', { type: 'DepositMoney', amountCents: 1 }, 6);
    expect(result.version).toBe(7);
    const rebuilt = await deps.accountService.rebuild('acct-1');
    expect(rebuilt.snapshotUsed).toEqual({ version: 6 });
    expect(rebuilt.state.balanceCents).toBe(result.state.balanceCents);
  });
});

describe('快照的边界与错误', () => {
  it('快照版本超出已有事件范围 → SNAPSHOT_VERSION_OUT_OF_RANGE', async () => {
    const err = await deps.accountService.createSnapshot('acct-1', 7).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('SNAPSHOT_VERSION_OUT_OF_RANGE');
    expect((err as AppError).httpStatus).toBe(400);
    expect((err as AppError).details).toMatchObject({ requestedVersion: 7, currentVersion: 6 });
  });

  it('快照版本为 0 或负数 → SNAPSHOT_VERSION_OUT_OF_RANGE', async () => {
    for (const bad of [0, -1]) {
      const err = await deps.accountService.createSnapshot('acct-1', bad).catch((e: unknown) => e);
      expect((err as AppError).code).toBe('SNAPSHOT_VERSION_OUT_OF_RANGE');
    }
  });

  it('对不存在的聚合打快照 → AGGREGATE_NOT_FOUND', async () => {
    const err = await deps.accountService.createSnapshot('ghost').catch((e: unknown) => e);
    expect((err as AppError).code).toBe('AGGREGATE_NOT_FOUND');
  });

  it('重建目标版本超出当前版本 → VERSION_OUT_OF_RANGE', async () => {
    const err = await deps.accountService.rebuild('acct-1', 99).catch((e: unknown) => e);
    expect((err as AppError).code).toBe('VERSION_OUT_OF_RANGE');
  });
});
