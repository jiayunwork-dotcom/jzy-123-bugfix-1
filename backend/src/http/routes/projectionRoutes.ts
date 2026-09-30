import type { FastifyInstance } from 'fastify';
import type { AccountProjection } from '../../projections/accountProjection.js';

export interface ProjectionRouteDeps {
  projection: AccountProjection;
}

/** 读模型相关接口（读侧） */
export function registerProjectionRoutes(app: FastifyInstance, deps: ProjectionRouteDeps): void {
  // 读模型当前内容：账户列表 + 余额汇总
  app.get('/api/projection/accounts', async () => {
    return deps.projection.status();
  });

  // 对读模型做一次全量重放，并返回重放结果
  app.post('/api/projection/accounts/replay', async () => {
    const startedAt = Date.now();
    const { processedEvents } = await deps.projection.replay();
    const status = await deps.projection.status();
    return { processedEvents, durationMs: Date.now() - startedAt, ...status };
  });
}
