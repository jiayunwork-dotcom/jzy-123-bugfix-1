import type { FastifyInstance } from 'fastify';
import { ValidationError } from '../../errors.js';
import type { AccountService } from '../../aggregates/accountService.js';
import type { EventStore } from '../../events/eventStore.js';
import type { SnapshotStore } from '../../events/snapshotStore.js';
import { optionalInt, parseAccountCommand, parseQueryInt, requireInt } from '../validate.js';

export interface AggregateRouteDeps {
  eventStore: EventStore;
  snapshotStore: SnapshotStore;
  accountService: AccountService;
}

/** 聚合 / 事件流 / 快照 相关接口（写侧） */
export function registerAggregateRoutes(app: FastifyInstance, deps: AggregateRouteDeps): void {
  // 聚合登记表（写侧元数据）
  app.get('/api/aggregates', async () => {
    const aggregates = await deps.eventStore.listAggregates();
    return { aggregates };
  });

  // 重建某聚合当前（或指定版本）的状态
  app.get('/api/aggregates/:id/state', async (req) => {
    const { id } = req.params as { id: string };
    const query = req.query as { atVersion?: string };
    const atVersion = parseQueryInt(query.atVersion, 'atVersion', { min: 0 });
    const result = await deps.accountService.rebuild(id, atVersion);
    return { aggregateId: id, ...result };
  });

  // 按版本区间取出该聚合的事件序列（完整事件重放）
  app.get('/api/aggregates/:id/events', async (req) => {
    const { id } = req.params as { id: string };
    const query = req.query as { fromVersion?: string; toVersion?: string };
    const fromVersion = parseQueryInt(query.fromVersion, 'fromVersion', { min: 1 }) ?? 1;
    const toVersion = parseQueryInt(query.toVersion, 'toVersion', { min: 1 });
    const events = await deps.eventStore.loadEvents(id, fromVersion, toVersion);
    return { aggregateId: id, fromVersion, toVersion: toVersion ?? null, events };
  });

  // 执行命令：校验通过后生成并追加事件（"追加一条新事件"的唯一入口）
  app.post('/api/aggregates/:id/commands', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') {
      throw new ValidationError('request body must be a JSON object');
    }
    const command = parseAccountCommand(body.command);
    const expectedVersion = requireInt(body.expectedVersion, 'expectedVersion', { min: 0 });
    const result = await deps.accountService.executeCommand(id, command, expectedVersion);
    return reply.status(201).send(result);
  });

  // 手动打快照（缺省对当前版本打）
  app.post('/api/aggregates/:id/snapshots', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const version = optionalInt(body.version, 'version', { min: 1 });
    const snapshot = await deps.accountService.createSnapshot(id, version);
    return reply.status(201).send({ snapshot });
  });

  // 某聚合的全部快照
  app.get('/api/aggregates/:id/snapshots', async (req) => {
    const { id } = req.params as { id: string };
    const snapshots = await deps.snapshotStore.list(id);
    return { aggregateId: id, snapshots };
  });
}
