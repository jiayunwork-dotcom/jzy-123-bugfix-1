import type { Pool, PoolClient } from '../db/pool.js';
import { AggregateNotFoundError, ValidationError, VersionConflictError } from '../errors.js';
import type { AggregateInfo, NewEvent, StoredEvent } from './types.js';

interface EventRow {
  global_seq: string | number;
  aggregate_id: string;
  aggregate_type: string;
  version: number;
  event_type: string;
  payload: unknown;
  created_at: Date;
}

const EVENT_COLUMNS = 'global_seq, aggregate_id, aggregate_type, version, event_type, payload, created_at';

function toStoredEvent(row: EventRow): StoredEvent {
  return {
    globalSeq: Number(row.global_seq),
    aggregateId: row.aggregate_id,
    aggregateType: row.aggregate_type,
    version: row.version,
    eventType: row.event_type,
    payload: row.payload,
    createdAt: row.created_at.toISOString(),
  };
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

/**
 * 事件存储：事件溯源的写侧核心。
 *
 * 硬规则：
 * 1. 事件只追加，落库后不可更改、不可删除（本类不提供任何更新/删除方法，
 *    数据库层另有触发器兜底）。
 * 2. 每条事件在所属聚合内拿到严格递增且连续的版本号（1, 2, 3, ...）。
 * 3. 追加采用乐观并发控制：调用方声明自己基于的版本 expectedVersion，
 *    与服务端当前版本不一致即判冲突、拒绝追加，由调用方拿最新状态重试。
 *
 * 对"不存在的聚合"的追加策略（二选一，这里选"隐式创建"）：
 *   - expectedVersion = 0 时视为创建该聚合，首条事件版本为 1；
 *   - expectedVersion > 0 而聚合不存在时，明确拒绝（AGGREGATE_NOT_FOUND），
 *     因为调用方声称基于一个从未存在过的历史版本，一定是请求有误。
 */
export class EventStore {
  constructor(private readonly pool: Pool) {}

  /**
   * 以事务方式追加一批事件（同一聚合、版本连续分配）。
   * 并发安全：先对聚合登记行加 FOR UPDATE 行锁，串行化同一聚合的并发追加；
   * UNIQUE(aggregate_id, version) 作为最后防线，唯一冲突同样判为版本冲突。
   */
  async append(
    aggregateId: string,
    aggregateType: string,
    expectedVersion: number,
    events: NewEvent[],
  ): Promise<StoredEvent[]> {
    if (typeof aggregateId !== 'string' || aggregateId.trim().length === 0) {
      throw new ValidationError('aggregateId must be a non-empty string');
    }
    if (typeof aggregateType !== 'string' || aggregateType.trim().length === 0) {
      throw new ValidationError('aggregateType must be a non-empty string');
    }
    if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
      throw new ValidationError('expectedVersion must be a non-negative integer', { expectedVersion });
    }
    if (!Array.isArray(events) || events.length === 0) {
      throw new ValidationError('at least one event is required');
    }
    for (const e of events) {
      if (!e || typeof e.eventType !== 'string' || e.eventType.trim().length === 0) {
        throw new ValidationError('every event requires a non-empty eventType');
      }
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const { rows } = await client.query(
        'SELECT aggregate_type, current_version FROM aggregates WHERE aggregate_id = $1 FOR UPDATE',
        [aggregateId],
      );
      const existing = rows[0] as { aggregate_type: string; current_version: number } | undefined;

      if (!existing) {
        if (expectedVersion !== 0) {
          throw new AggregateNotFoundError(aggregateId, { expectedVersion });
        }
        await client.query(
          'INSERT INTO aggregates (aggregate_id, aggregate_type, current_version) VALUES ($1, $2, 0)',
          [aggregateId, aggregateType],
        );
      } else {
        if (existing.aggregate_type !== aggregateType) {
          throw new ValidationError(
            `aggregate '${aggregateId}' has type '${existing.aggregate_type}', not '${aggregateType}'`,
          );
        }
        if (existing.current_version !== expectedVersion) {
          throw new VersionConflictError(aggregateId, expectedVersion, existing.current_version);
        }
      }

      const inserted: StoredEvent[] = [];
      let version = expectedVersion;
      for (const event of events) {
        version += 1;
        const { rows: insertedRows } = await client.query(
          `INSERT INTO events (aggregate_id, aggregate_type, version, event_type, payload)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING ${EVENT_COLUMNS}`,
          [aggregateId, aggregateType, version, event.eventType, JSON.stringify(event.payload ?? {})],
        );
        inserted.push(toStoredEvent(insertedRows[0] as EventRow));
      }

      await client.query('UPDATE aggregates SET current_version = $2 WHERE aggregate_id = $1', [
        aggregateId,
        version,
      ]);
      await client.query('COMMIT');
      return inserted;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (isUniqueViolation(err)) {
        // 兜底：并发创建同一聚合 / 绕过行锁的并发写入，统一判为并发冲突
        const actual = await this.getCurrentVersion(aggregateId).catch(() => null);
        throw new VersionConflictError(aggregateId, expectedVersion, actual);
      }
      throw err;
    } finally {
      client.release();
    }
  }

  /** 聚合当前版本；聚合不存在时返回 null */
  async getCurrentVersion(aggregateId: string): Promise<number | null> {
    const { rows } = await this.pool.query(
      'SELECT current_version FROM aggregates WHERE aggregate_id = $1',
      [aggregateId],
    );
    return rows.length === 0 ? null : (rows[0].current_version as number);
  }

  /**
   * 按版本区间取出某聚合的事件序列（含边界），按版本升序。
   * 区间上界允许超过当前版本（视为截断到当前版本）；聚合不存在则 404。
   */
  async loadEvents(aggregateId: string, fromVersion = 1, toVersion?: number): Promise<StoredEvent[]> {
    if (!Number.isInteger(fromVersion) || fromVersion < 1) {
      throw new ValidationError('fromVersion must be an integer >= 1', { fromVersion });
    }
    if (toVersion !== undefined && (!Number.isInteger(toVersion) || toVersion < fromVersion)) {
      throw new ValidationError('toVersion must be an integer >= fromVersion', { fromVersion, toVersion });
    }
    const current = await this.getCurrentVersion(aggregateId);
    if (current === null) throw new AggregateNotFoundError(aggregateId);

    const params: unknown[] = [aggregateId, fromVersion];
    let sql = `SELECT ${EVENT_COLUMNS} FROM events WHERE aggregate_id = $1 AND version >= $2`;
    if (toVersion !== undefined) {
      params.push(toVersion);
      sql += ' AND version <= $3';
    }
    sql += ' ORDER BY version ASC';
    const { rows } = await this.pool.query(sql, params);
    return (rows as EventRow[]).map(toStoredEvent);
  }

  /** 全局事件流：globalSeq 大于 fromGlobalSeq 的所有事件，按全局序号升序（投影增量消费用） */
  async loadAllEvents(fromGlobalSeq = 0, client?: PoolClient): Promise<StoredEvent[]> {
    const queryable = client ?? this.pool;
    const { rows } = await queryable.query(
      `SELECT ${EVENT_COLUMNS} FROM events WHERE global_seq > $1 ORDER BY global_seq ASC`,
      [fromGlobalSeq],
    );
    return (rows as EventRow[]).map(toStoredEvent);
  }

  /** 全局事件流在某个序号处的一致切片（投影全量重放用，需在事务内调用） */
  async loadAllEventsUpTo(maxGlobalSeq: number, client?: PoolClient): Promise<StoredEvent[]> {
    const queryable = client ?? this.pool;
    const { rows } = await queryable.query(
      `SELECT ${EVENT_COLUMNS} FROM events WHERE global_seq <= $1 ORDER BY global_seq ASC`,
      [maxGlobalSeq],
    );
    return (rows as EventRow[]).map(toStoredEvent);
  }

  /** 当前最大全局序号（无事件时为 0） */
  async maxGlobalSeq(client?: PoolClient): Promise<number> {
    const queryable = client ?? this.pool;
    const { rows } = await queryable.query('SELECT COALESCE(MAX(global_seq), 0) AS max_seq FROM events');
    return Number(rows[0].max_seq);
  }

  async listAggregates(): Promise<AggregateInfo[]> {
    const { rows } = await this.pool.query(
      'SELECT aggregate_id, aggregate_type, current_version, created_at FROM aggregates ORDER BY created_at ASC, aggregate_id ASC',
    );
    return rows.map((row) => ({
      aggregateId: row.aggregate_id as string,
      aggregateType: row.aggregate_type as string,
      currentVersion: row.current_version as number,
      createdAt: (row.created_at as Date).toISOString(),
    }));
  }
}
