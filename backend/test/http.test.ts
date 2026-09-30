import type { FastifyInstance } from 'fastify';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/http/server.js';
import { setupTestDeps, teardownTestDeps, type TestDeps } from './helpers.js';

let deps: TestDeps;
let app: FastifyInstance;

beforeEach(async () => {
  deps = await setupTestDeps();
  app = await buildServer(deps);
});

afterAll(async () => {
  if (deps) await teardownTestDeps(deps);
});

interface ApiBody {
  error?: { code: string; message: string; details: unknown };
  [key: string]: unknown;
}

async function post(path: string, body: unknown) {
  const res = await app.inject({ method: 'POST', url: path, payload: body as Record<string, unknown> });
  return { status: res.statusCode, body: res.json() as ApiBody };
}

async function get(path: string) {
  const res = await app.inject({ method: 'GET', url: path });
  return { status: res.statusCode, body: res.json() as ApiBody };
}

describe('HTTP API：完整流程', () => {
  it('创建 → 存 → 取 → 查状态 → 查事件 → 打快照 → 查投影 → 全量重放', async () => {
    // 创建账户
    const created = await post('/api/aggregates/acct-1/commands', {
      command: { type: 'CreateAccount', owner: 'alice', initialBalanceCents: 10_000 },
      expectedVersion: 0,
    });
    expect(created.status).toBe(201);
    expect(created.body.version).toBe(1);
    expect((created.body.state as { balanceCents: number }).balanceCents).toBe(10_000);

    // 存款、取款
    const deposited = await post('/api/aggregates/acct-1/commands', {
      command: { type: 'DepositMoney', amountCents: 500 },
      expectedVersion: 1,
    });
    expect(deposited.status).toBe(201);
    const withdrawn = await post('/api/aggregates/acct-1/commands', {
      command: { type: 'WithdrawMoney', amountCents: 300 },
      expectedVersion: 2,
    });
    expect(withdrawn.status).toBe(201);
    expect((withdrawn.body.state as { balanceCents: number }).balanceCents).toBe(10_200);

    // 当前状态（重建）
    const state = await get('/api/aggregates/acct-1/state');
    expect(state.status).toBe(200);
    expect(state.body.version).toBe(3);
    expect((state.body.state as { balanceCents: number }).balanceCents).toBe(10_200);
    expect(state.body.snapshotUsed).toBeNull();

    // 历史某版本的状态
    const atV1 = await get('/api/aggregates/acct-1/state?atVersion=1');
    expect((atV1.body.state as { balanceCents: number }).balanceCents).toBe(10_000);

    // 事件时间线 + 区间
    const events = await get('/api/aggregates/acct-1/events');
    expect((events.body.events as unknown[]).length).toBe(3);
    const slice = await get('/api/aggregates/acct-1/events?fromVersion=2&toVersion=2');
    const sliceEvents = slice.body.events as Array<{ version: number; eventType: string }>;
    expect(sliceEvents).toHaveLength(1);
    expect(sliceEvents[0]).toMatchObject({ version: 2, eventType: 'MoneyDeposited' });

    // 打快照
    const snap = await post('/api/aggregates/acct-1/snapshots', { version: 2 });
    expect(snap.status).toBe(201);
    const snaps = await get('/api/aggregates/acct-1/snapshots');
    expect((snaps.body.snapshots as unknown[]).length).toBe(1);

    // 打过快照后重建仍正确，且标记使用了快照
    const stateAfterSnap = await get('/api/aggregates/acct-1/state');
    expect(stateAfterSnap.body.snapshotUsed).toEqual({ version: 2 });
    expect((stateAfterSnap.body.state as { balanceCents: number }).balanceCents).toBe(10_200);

    // 读模型（命令执行后已增量跟进）
    const projection = await get('/api/projection/accounts');
    expect(projection.status).toBe(200);
    const accounts = projection.body.accounts as Array<{ aggregateId: string; balanceCents: number }>;
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ aggregateId: 'acct-1', balanceCents: 10_200 });
    expect((projection.body.summary as { totalBalanceCents: number }).totalBalanceCents).toBe(10_200);

    // 全量重放
    const replay = await post('/api/projection/accounts/replay', {});
    expect(replay.status).toBe(200);
    expect(replay.body.processedEvents).toBe(3);
    // 重放结果与增量消费结果在业务字段上逐字段一致（updatedAt 时间戳除外）
    const replayAccounts = (replay.body.accounts as Array<Record<string, unknown>>).map(
      ({ aggregateId, owner, balanceCents, version }) => ({ aggregateId, owner, balanceCents, version }),
    );
    const incrementalAccounts = accounts.map(({ aggregateId, balanceCents }) => ({
      aggregateId,
      owner: 'alice',
      balanceCents,
      version: 3,
    }));
    expect(replayAccounts).toEqual(incrementalAccounts);

    // 聚合登记表
    const list = await get('/api/aggregates');
    const aggregates = list.body.aggregates as Array<{ aggregateId: string; currentVersion: number }>;
    expect(aggregates).toEqual([expect.objectContaining({ aggregateId: 'acct-1', currentVersion: 3 })]);
  });
});

describe('HTTP API：错误响应', () => {
  it('并发版本不匹配 → 409 VERSION_CONFLICT', async () => {
    await post('/api/aggregates/acct-1/commands', {
      command: { type: 'CreateAccount', owner: 'alice' },
      expectedVersion: 0,
    });
    const res = await post('/api/aggregates/acct-1/commands', {
      command: { type: 'DepositMoney', amountCents: 100 },
      expectedVersion: 0,
    });
    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe('VERSION_CONFLICT');
    expect(res.body.error?.details).toMatchObject({ expectedVersion: 0, actualVersion: 1 });
  });

  it('不存在的聚合：查状态 / 查事件 → 404 AGGREGATE_NOT_FOUND', async () => {
    const state = await get('/api/aggregates/ghost/state');
    expect(state.status).toBe(404);
    expect(state.body.error?.code).toBe('AGGREGATE_NOT_FOUND');
    const events = await get('/api/aggregates/ghost/events');
    expect(events.status).toBe(404);
    expect(events.body.error?.code).toBe('AGGREGATE_NOT_FOUND');
  });

  it('对不存在的聚合执行非创建命令 → 404', async () => {
    const res = await post('/api/aggregates/ghost/commands', {
      command: { type: 'DepositMoney', amountCents: 100 },
      expectedVersion: 0,
    });
    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe('AGGREGATE_NOT_FOUND');
  });

  it('余额不足 → 422 INSUFFICIENT_FUNDS', async () => {
    await post('/api/aggregates/acct-1/commands', {
      command: { type: 'CreateAccount', owner: 'alice', initialBalanceCents: 50 },
      expectedVersion: 0,
    });
    const res = await post('/api/aggregates/acct-1/commands', {
      command: { type: 'WithdrawMoney', amountCents: 51 },
      expectedVersion: 1,
    });
    expect(res.status).toBe(422);
    expect(res.body.error?.code).toBe('INSUFFICIENT_FUNDS');
  });

  it('非法金额 / 非法命令 / 缺 expectedVersion → 400 VALIDATION_FAILED', async () => {
    const badAmount = await post('/api/aggregates/acct-1/commands', {
      command: { type: 'DepositMoney', amountCents: -5 },
      expectedVersion: 0,
    });
    expect(badAmount.status).toBe(400);
    expect(badAmount.body.error?.code).toBe('VALIDATION_FAILED');

    const badCommand = await post('/api/aggregates/acct-1/commands', {
      command: { type: 'FlyToMoon' },
      expectedVersion: 0,
    });
    expect(badCommand.status).toBe(400);

    const missingVersion = await post('/api/aggregates/acct-1/commands', {
      command: { type: 'CreateAccount', owner: 'a' },
    });
    expect(missingVersion.status).toBe(400);
    expect(missingVersion.body.error?.code).toBe('VALIDATION_FAILED');
  });

  it('快照版本超出范围 → 400 SNAPSHOT_VERSION_OUT_OF_RANGE', async () => {
    await post('/api/aggregates/acct-1/commands', {
      command: { type: 'CreateAccount', owner: 'alice' },
      expectedVersion: 0,
    });
    const res = await post('/api/aggregates/acct-1/snapshots', { version: 2 });
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('SNAPSHOT_VERSION_OUT_OF_RANGE');
  });

  it('重建目标版本超出范围 → 400 VERSION_OUT_OF_RANGE', async () => {
    await post('/api/aggregates/acct-1/commands', {
      command: { type: 'CreateAccount', owner: 'alice' },
      expectedVersion: 0,
    });
    const res = await get('/api/aggregates/acct-1/state?atVersion=9');
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('VERSION_OUT_OF_RANGE');
  });

  it('非法的区间参数 → 400 VALIDATION_FAILED', async () => {
    await post('/api/aggregates/acct-1/commands', {
      command: { type: 'CreateAccount', owner: 'alice' },
      expectedVersion: 0,
    });
    const res = await get('/api/aggregates/acct-1/events?fromVersion=abc');
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('VALIDATION_FAILED');
  });
});
