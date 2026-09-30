import type { Pool, PoolClient } from '../db/pool.js';
import type { EventStore } from '../events/eventStore.js';
import type { StoredEvent } from '../events/types.js';

export interface ProjectionAccountRow {
  aggregateId: string;
  owner: string;
  balanceCents: number;
  version: number;
  updatedAt: string;
}

export interface ProjectionStatus {
  name: string;
  /** 已消费到的全局事件序号 */
  lastProcessedSeq: number;
  accounts: ProjectionAccountRow[];
  summary: {
    totalAccounts: number;
    totalBalanceCents: number;
  };
}

interface ProjectionRow {
  aggregate_id: string;
  owner: string;
  balance_cents: string | number;
  version: number;
  updated_at: Date;
}

/**
 * 账户读模型投影（CQRS 的读侧）。
 *
 * 两种消费方式，结果必须完全一致（框架最要命的不变量，由测试锁定）：
 * - processNewEvents()：增量消费 —— 从检查点之后继续应用新事件；
 * - replay()：全量重放 —— 清空读模型，从头消费整条事件流重新算。
 *
 * 读模型是纯粹的派生物，任何时候都可以通过 replay() 重建。
 */
export class AccountProjection {
  static readonly NAME = 'account_projection';

  constructor(
    private readonly pool: Pool,
    private readonly eventStore: EventStore,
  ) {}

  /** 把一条事件应用到读模型（在调用方的事务里执行） */
  private async applyEvent(client: PoolClient, event: StoredEvent): Promise<void> {
    switch (event.eventType) {
      case 'AccountCreated': {
        const payload = event.payload as { owner: string; initialBalanceCents: number };
        await client.query(
          `INSERT INTO projection_accounts (aggregate_id, owner, balance_cents, version, updated_at)
           VALUES ($1, $2, $3, $4, now())
           ON CONFLICT (aggregate_id) DO UPDATE
             SET owner = EXCLUDED.owner,
                 balance_cents = EXCLUDED.balance_cents,
                 version = EXCLUDED.version,
                 updated_at = now()`,
          [event.aggregateId, payload.owner, payload.initialBalanceCents, event.version],
        );
        break;
      }
      case 'MoneyDeposited':
      case 'MoneyWithdrawn': {
        const { amountCents } = event.payload as { amountCents: number };
        const delta = event.eventType === 'MoneyDeposited' ? amountCents : -amountCents;
        await client.query(
          `UPDATE projection_accounts
             SET balance_cents = balance_cents + $2, version = $3, updated_at = now()
           WHERE aggregate_id = $1`,
          [event.aggregateId, delta, event.version],
        );
        break;
      }
      default:
        // 与账户读模型无关的事件类型直接忽略
        break;
    }
  }

  /** 取检查点并加行锁（串行化并发的增量消费） */
  private async lockCheckpoint(client: PoolClient): Promise<number> {
    await client.query(
      `INSERT INTO projection_checkpoints (projection_name, last_global_seq) VALUES ($1, 0)
       ON CONFLICT (projection_name) DO NOTHING`,
      [AccountProjection.NAME],
    );
    const { rows } = await client.query(
      'SELECT last_global_seq FROM projection_checkpoints WHERE projection_name = $1 FOR UPDATE',
      [AccountProjection.NAME],
    );
    return Number(rows[0].last_global_seq);
  }

  /** 增量消费：应用检查点之后的新事件，返回本次处理的条数 */
  async processNewEvents(): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const checkpoint = await this.lockCheckpoint(client);
      const events = await this.eventStore.loadAllEvents(checkpoint, client);
      let last = checkpoint;
      for (const event of events) {
        await this.applyEvent(client, event);
        last = event.globalSeq;
      }
      await client.query(
        'UPDATE projection_checkpoints SET last_global_seq = $2 WHERE projection_name = $1',
        [AccountProjection.NAME, last],
      );
      await client.query('COMMIT');
      return events.length;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * 全量重放：在单个事务里清空读模型、从头消费到一致切点（重放开始时的最大全局序号），
   * 再把检查点推到该切点。返回处理的事件条数。
   */
  async replay(): Promise<{ processedEvents: number }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM projection_accounts');
      const maxSeq = await this.eventStore.maxGlobalSeq(client);
      const events = await this.eventStore.loadAllEventsUpTo(maxSeq, client);
      for (const event of events) {
        await this.applyEvent(client, event);
      }
      await client.query(
        `INSERT INTO projection_checkpoints (projection_name, last_global_seq) VALUES ($1, $2)
         ON CONFLICT (projection_name) DO UPDATE SET last_global_seq = EXCLUDED.last_global_seq`,
        [AccountProjection.NAME, maxSeq],
      );
      await client.query('COMMIT');
      return { processedEvents: events.length };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** 读模型当前内容 + 汇总 */
  async status(): Promise<ProjectionStatus> {
    const [{ rows: accountRows }, { rows: checkpointRows }] = await Promise.all([
      this.pool.query(
        'SELECT aggregate_id, owner, balance_cents, version, updated_at FROM projection_accounts ORDER BY aggregate_id ASC',
      ),
      this.pool.query('SELECT last_global_seq FROM projection_checkpoints WHERE projection_name = $1', [
        AccountProjection.NAME,
      ]),
    ]);
    const accounts: ProjectionAccountRow[] = (accountRows as ProjectionRow[]).map((row) => ({
      aggregateId: row.aggregate_id,
      owner: row.owner,
      balanceCents: Number(row.balance_cents),
      version: row.version,
      updatedAt: row.updated_at.toISOString(),
    }));
    return {
      name: AccountProjection.NAME,
      lastProcessedSeq: checkpointRows.length === 0 ? 0 : Number(checkpointRows[0].last_global_seq),
      accounts,
      summary: {
        totalAccounts: accounts.length,
        totalBalanceCents: accounts.reduce((sum, a) => sum + a.balanceCents, 0),
      },
    };
  }
}
