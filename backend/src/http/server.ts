import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import type { AccountService } from '../aggregates/accountService.js';
import { AppError } from '../errors.js';
import type { EventStore } from '../events/eventStore.js';
import type { SnapshotStore } from '../events/snapshotStore.js';
import type { AccountProjection } from '../projections/accountProjection.js';
import { registerAggregateRoutes } from './routes/aggregateRoutes.js';
import { registerProjectionRoutes } from './routes/projectionRoutes.js';

export interface ServerDeps {
  eventStore: EventStore;
  snapshotStore: SnapshotStore;
  accountService: AccountService;
  projection: AccountProjection;
}

export async function buildServer(
  deps: ServerDeps,
  opts: { logger?: boolean } = {},
): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false });

  await app.register(cors, { origin: true });

  // 统一错误响应：{ error: { code, message, details } }
  app.setErrorHandler((err: unknown, req, reply) => {
    if (err instanceof AppError) {
      return reply
        .status(err.httpStatus)
        .send({ error: { code: err.code, message: err.message, details: err.details ?? null } });
    }
    // Fastify 自身的请求解析错误（如 JSON 语法错误、body 过大）
    const asHttpError = err as { statusCode?: number; message?: string };
    if (typeof asHttpError.statusCode === 'number' && asHttpError.statusCode >= 400 && asHttpError.statusCode < 500) {
      return reply
        .status(asHttpError.statusCode)
        .send({ error: { code: 'BAD_REQUEST', message: asHttpError.message ?? 'bad request', details: null } });
    }
    req.log.error(err);
    return reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: 'internal server error', details: null } });
  });

  app.get('/api/health', async () => ({ status: 'ok' }));

  registerAggregateRoutes(app, deps);
  registerProjectionRoutes(app, deps);

  return app;
}
