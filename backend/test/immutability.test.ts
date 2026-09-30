import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { setupTestDeps, teardownTestDeps, type TestDeps } from './helpers.js';

let deps: TestDeps;

beforeEach(async () => {
  deps = await setupTestDeps();
  await deps.accountService.executeCommand('acct-1', { type: 'CreateAccount', owner: 'alice', initialBalanceCents: 100 }, 0);
  await deps.accountService.executeCommand('acct-1', { type: 'DepositMoney', amountCents: 50 }, 1);
  await deps.accountService.executeCommand('acct-1', { type: 'WithdrawMoney', amountCents: 30 }, 2);
});

afterAll(async () => {
  if (deps) await teardownTestDeps(deps);
});

describe('事件不可变性：一旦写入，内容与顺序不被任何后续操作改变', () => {
  it('数据库层拒绝 UPDATE 事件', async () => {
    await expect(
      deps.pool.query(`UPDATE events SET payload = '{"hacked":true}' WHERE aggregate_id = 'acct-1'`),
    ).rejects.toThrow(/immutable/i);
    // 数据原样
    const events = await deps.eventStore.loadEvents('acct-1');
    expect(events.map((e) => e.eventType)).toEqual(['AccountCreated', 'MoneyDeposited', 'MoneyWithdrawn']);
  });

  it('数据库层拒绝 DELETE 事件', async () => {
    await expect(deps.pool.query(`DELETE FROM events WHERE aggregate_id = 'acct-1'`)).rejects.toThrow(
      /immutable/i,
    );
    expect(await deps.eventStore.loadEvents('acct-1')).toHaveLength(3);
  });

  it('数据库层拒绝 TRUNCATE 事件表', async () => {
    await expect(deps.pool.query('TRUNCATE events')).rejects.toThrow(/immutable/i);
    expect(await deps.eventStore.loadEvents('acct-1')).toHaveLength(3);
  });

  it('继续追加、打快照、投影重放之后，已有事件的内容与顺序保持不变', async () => {
    const original = await deps.eventStore.loadEvents('acct-1');

    // 各种后续操作
    await deps.accountService.executeCommand('acct-1', { type: 'DepositMoney', amountCents: 10 }, 3);
    await deps.accountService.createSnapshot('acct-1', 2);
    await deps.accountService.createSnapshot('acct-1', 4);
    await deps.projection.replay();
    await deps.accountService.executeCommand('acct-2', { type: 'CreateAccount', owner: 'bob' }, 0);

    // 原事件逐条逐字段一致（含全局序号与版本），且顺序不变
    const after = await deps.eventStore.loadEvents('acct-1', 1, 3);
    expect(after).toEqual(original);

    // 新事件只能追加在后面：版本 4，且全局序号大于所有旧事件
    const all = await deps.eventStore.loadEvents('acct-1');
    expect(all.map((e) => e.version)).toEqual([1, 2, 3, 4]);
    const maxOldSeq = Math.max(...original.map((e) => e.globalSeq));
    expect(all[3].globalSeq).toBeGreaterThan(maxOldSeq);
  });
});
