import type { Pool } from '../db/pool.js';
import type { Snapshot } from './types.js';

interface SnapshotRow {
  aggregate_id: string;
  version: number;
  state: unknown;
  created_at: Date;
}

function toSnapshot(row: SnapshotRow): Snapshot {
  return {
    aggregateId: row.aggregate_id,
    version: row.version,
    state: row.state,
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * 快照存储。
 *
 * 快照是纯粹的派生数据：它记录"到某个版本为止重放出的状态"，唯一用途是加速重建。
 * 无论是否存在快照、快照打在哪个版本，重建结果都必须与全量重放一致
 * （该不变量由测试锁定）。因此同版本快照允许覆盖——重算出的状态必然相同。
 */
export class SnapshotStore {
  constructor(private readonly pool: Pool) {}

  async save(aggregateId: string, version: number, state: unknown): Promise<Snapshot> {
    const { rows } = await this.pool.query(
      `INSERT INTO snapshots (aggregate_id, version, state) VALUES ($1, $2, $3)
       ON CONFLICT (aggregate_id, version) DO UPDATE SET state = EXCLUDED.state, created_at = now()
       RETURNING aggregate_id, version, state, created_at`,
      [aggregateId, version, JSON.stringify(state)],
    );
    return toSnapshot(rows[0] as SnapshotRow);
  }

  /** 取版本不超过 maxVersion 的最近一份快照；不带 maxVersion 时取全局最近一份 */
  async getLatest(aggregateId: string, maxVersion?: number): Promise<Snapshot | null> {
    const params: unknown[] = [aggregateId];
    let sql = 'SELECT aggregate_id, version, state, created_at FROM snapshots WHERE aggregate_id = $1';
    if (maxVersion !== undefined) {
      params.push(maxVersion);
      sql += ' AND version <= $2';
    }
    sql += ' ORDER BY version DESC LIMIT 1';
    const { rows } = await this.pool.query(sql, params);
    return rows.length === 0 ? null : toSnapshot(rows[0] as SnapshotRow);
  }

  async list(aggregateId: string): Promise<Snapshot[]> {
    const { rows } = await this.pool.query(
      'SELECT aggregate_id, version, state, created_at FROM snapshots WHERE aggregate_id = $1 ORDER BY version DESC',
      [aggregateId],
    );
    return (rows as SnapshotRow[]).map(toSnapshot);
  }
}
