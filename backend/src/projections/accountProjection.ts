import type { Pool, PoolClient } from '../db/pool.js';
import { ACCOUNT_AGGREGATE_TYPE } from '../domain/account.js';
import type { EventStore } from '../events/eventStore.js';
import type { StoredEvent } from '../events/types.js';

export interface ProjectionAccountRow {
  aggregateId: string;
  owner: string;
  balanceCents: number;
  version: number;
  updatedAt: string;
}

export interface ProjectionLaggingStream {
  aggregateId: string;
  /** 该账户写侧的当前版本 */
  currentVersion: number;
  /** 读模型已消费到的版本 */
  processedVersion: number;
  /** 落后的事件条数 */
  lagEvents: number;
}

export interface ProjectionStatus {
  name: string;
  /**
   * 已确定消费完整的全局事件序号连续前缀上界（保守水位）。
   * 它可能小于写侧最新 global_seq：存在提交中的事务或读模型尚未跟进时，
   * 这里会如实停住而不是虚报追平。字段保留原语义名不变（仅新增字段）。
   */
  lastProcessedSeq: number;
  /** 写侧当前最大全局序号 */
  latestGlobalSeq: number;
  /** 读模型尚未消费的已提交账户事件条数（落后即 > 0） */
  lagEvents: number;
  /** 读模型是否已追平写侧 */
  caughtUp: boolean;
  /** 逐账户的落后明细（空数组表示全部追平） */
  laggingStreams: ProjectionLaggingStream[];
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

interface PendingEventRow {
  global_seq: string | number;
  aggregate_id: string;
  version: number;
  event_type: string;
  payload: unknown;
  created_at: Date;
}

const PENDING_EVENT_COLUMNS = 'global_seq, aggregate_id, version, event_type, payload, created_at';

/**
 * 投影增量消费 / 全量重放共用的事务级咨询锁键（固定常量，重启即释放，无死表风险）。
 * 保证两类消费互斥：重放清空读模型期间，增量消费不能往旧状态上叠事件
 * （否则重放结束后这些事件会被重复应用）。
 */
const PROJECTION_LOCK_KEY = 9102001;

/**
 * 账户读模型投影（CQRS 的读侧）。
 *
 * 两种消费方式，结果必须完全一致（框架最要命的不变量，由测试锁定）：
 * - processNewEvents()：增量消费 —— 从每个聚合流的检查点之后继续应用新事件；
 * - replay()：全量重放 —— 清空读模型，从头消费整条事件流重新算。
 *
 * 消费依据是"每个聚合各自的连续版本号"，而不是全局 global_seq：
 * global_seq 在 INSERT 时（COMMIT 之前）分配，并发事务下序号顺序与提交可见
 * 顺序不一致，按全局序号推进检查点会跳过尚不可见的小序号事件，且再也不补。
 * 聚合内版本号则由 aggregates 行锁 + UNIQUE(aggregate_id, version) 保证
 * "连续且提交顺序即可见顺序"，按流推进没有空洞可跳。
 *
 * 读模型是纯粹的派生物，任何时候都可以通过 replay() 重建。
 */
export class AccountProjection {
  static readonly NAME = 'account_projection';

  constructor(
    private readonly pool: Pool,
    // 保留构造签名（装配处与测试仍传入 EventStore），但消费改为直接按流查询。
    _eventStore: EventStore,
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
        const { rowCount } = await client.query(
          `UPDATE projection_accounts
             SET balance_cents = balance_cents + $2, version = $3, updated_at = now()
           WHERE aggregate_id = $1`,
          [event.aggregateId, delta, event.version],
        );
        // 防御性检查：账户行不存在说明消费顺序被破坏（理论上按版本流不可能发生）。
        // 宁可显式失败、让事务回滚并在状态接口暴露落后，也不能静默写丢。
        if (rowCount !== 1) {
          throw new Error(
            `projection invariant violated: ${event.eventType} for '${event.aggregateId}' ` +
              `v${event.version} matched ${rowCount} rows (AccountCreated missing?)`,
          );
        }
        break;
      }
      default:
        // 与账户读模型无关的事件类型直接忽略
        break;
    }
  }

  /** 取投影互斥锁（事务级，事务提交/回滚/连接断开时自动释放） */
  private async acquireProjectionLock(client: PoolClient): Promise<void> {
    await client.query('SELECT pg_advisory_xact_lock($1)', [PROJECTION_LOCK_KEY]);
  }

  /**
   * 取每个账户流"检查点之后的下一条事件"（单条 SQL 完成流发现）。
   * LEFT JOIN ... IS NULL 同时覆盖"还没有检查点行的新聚合"。
   * 返回的行互不依赖：它们都是各自流里当前最靠前的未消费事件，
   * 其之前的版本要么已在检查点之前消费，要么不可能已提交（行锁串行化追加）。
   */
  private async loadPendingEvents(client: PoolClient): Promise<PendingEventRow[]> {
    const { rows } = await client.query(
      `SELECT e.${PENDING_EVENT_COLUMNS.split(', ').join(', e.')}
         FROM events e
         LEFT JOIN projection_stream_checkpoints c
           ON c.projection_name = $1 AND c.aggregate_id = e.aggregate_id
        WHERE e.aggregate_type = $2
          AND e.version > COALESCE(c.last_version, 0)
          AND NOT EXISTS (
            SELECT 1 FROM events e2
            WHERE e2.aggregate_id = e.aggregate_id
              AND e2.version > COALESCE(c.last_version, 0)
              AND e2.version < e.version
          )
        ORDER BY e.aggregate_id ASC, e.version ASC`,
      [AccountProjection.NAME, ACCOUNT_AGGREGATE_TYPE],
    );
    return rows as PendingEventRow[];
  }

  /**
   * 保守全局水位：读模型"已确定吃满、且确定不会再有更小序号冒出来"的全局序号上界。
   *
   * 取以下两者的较小值：
   *  1) 流内下沿：每个账户流"版本号 > 检查点"的最小事件 seq 减 1（没有则 +∞）。
   *  2) 在途钳制：若存在"正在向 events 表写入且尚未提交/回滚"的其它事务，
   *     水位不超过"其中最早开始的那个事务开始之前已提交的最大事件 seq"。
   *
   * 为什么需要 (2)：global_seq 在 INSERT 时（COMMIT 前）分配，未提交事务占用的
   * 序号在 READ COMMITTED 下对 events 表完全不可见，单靠流内下沿无从得知
   * "有个更小的序号正在路上"。pg_stat_activity.backend_xid 非空标识已产生写入的
   * 事务，配合 pg_locks 中 events 表上的 RowExclusiveLock 精确锁定"事件写入事务"，
   * 把它们的 xact_start 之前已提交（created_at 严格更早）的最大 seq 作为安全钳点：
   * 在途事务能拿到的任何 seq 都不会小于该钳点，因此钳点之前不存在被它遮蔽的洞。
   * 无在途写事务时该钳制为 +∞（取 NULL 最小值时自然被忽略）。
   */
  private async computeGlobalWatermark(client: PoolClient): Promise<number> {
    const { rows } = await client.query(
      `WITH
         stream_floor AS (
           SELECT MIN(e.global_seq) - 1 AS seq
             FROM events e
             LEFT JOIN projection_stream_checkpoints c
               ON c.projection_name = $1 AND c.aggregate_id = e.aggregate_id
            WHERE e.aggregate_type = $2
              AND e.version > COALESCE(c.last_version, 0)
         ),
         inflight AS (
           SELECT min(a.xact_start) AS oldest_start
             FROM pg_stat_activity a
             JOIN pg_locks l
               ON l.pid = a.pid
              AND l.locktype = 'relation'
              AND l.relation = 'events'::regclass
              AND l.mode = 'RowExclusiveLock'
            WHERE a.datname = current_database()
              AND a.pid <> pg_backend_pid()
              AND a.backend_xid IS NOT NULL
         ),
         inflight_clamp AS (
           SELECT COALESCE((
             SELECT MAX(e.global_seq) FROM events e, inflight i
              WHERE i.oldest_start IS NOT NULL
                AND e.created_at < i.oldest_start
           ), NULL) AS seq
         )
      SELECT COALESCE(
               LEAST((SELECT seq FROM stream_floor), (SELECT seq FROM inflight_clamp)),
               (SELECT seq FROM stream_floor),
               (SELECT seq FROM inflight_clamp),
               (SELECT COALESCE(MAX(global_seq), 0) FROM events)
             ) AS watermark`,
      [AccountProjection.NAME, ACCOUNT_AGGREGATE_TYPE],
    );
    return Number((rows[0] as { watermark: string | number }).watermark);
  }

  /** 把各流检查点推进到本次实际应用到的版本 */
  private async upsertStreamCheckpoints(
    client: PoolClient,
    highWater: Map<string, number>,
  ): Promise<void> {
    if (highWater.size === 0) return;
    const values: unknown[] = [];
    const selectRows: string[] = [];
    let idx = 1;
    for (const [aggregateId, version] of highWater) {
      selectRows.push(`($${idx}, $${idx + 1}, $${idx + 2})`);
      values.push(AccountProjection.NAME, aggregateId, version);
      idx += 3;
    }
    await client.query(
      `INSERT INTO projection_stream_checkpoints (projection_name, aggregate_id, last_version)
       VALUES ${selectRows.join(', ')}
       ON CONFLICT (projection_name, aggregate_id) DO UPDATE
         SET last_version = EXCLUDED.last_version, updated_at = now()`,
      values,
    );
  }

  /** 写入旧的全局检查点表（仅用于对外报水位）；水位单调不减，取新旧较大值 */
  private async writeGlobalCheckpoint(client: PoolClient, seq: number): Promise<void> {
    await client.query(
      `INSERT INTO projection_checkpoints (projection_name, last_global_seq) VALUES ($1, $2)
       ON CONFLICT (projection_name) DO UPDATE
         SET last_global_seq = GREATEST(projection_checkpoints.last_global_seq, EXCLUDED.last_global_seq)`,
      [AccountProjection.NAME, seq],
    );
  }

  /**
   * 增量消费：对每个账户流，从该流检查点之后取出连续的已提交事件前缀并应用，
   * 再推进该流检查点。返回本次处理的条数。
   *
   * 整个过程在单事务 + 投影互斥锁内完成：要么整体生效，要么整体回滚；
   * 中途失败时检查点不前移，下次 processNewEvents / replay 从同一位置继续。
   */
  async processNewEvents(): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.acquireProjectionLock(client);

      // 第一轮：找到每个流的下一条待消费事件
      const heads = await this.loadPendingEvents(client);
      if (heads.length === 0) {
        const watermark = await this.computeGlobalWatermark(client);
        await this.writeGlobalCheckpoint(client, watermark);
        await client.query('COMMIT');
        return 0;
      }

      // 第二轮：逐流从起点版本开始取出该流全部事件（一个连接上顺序查询）。
      // 起点版本必定是该流检查点 + 1：同一聚合的追加被 aggregates 行锁串行化，
      // 已提交的版本前缀不可能有中间空洞。
      let processed = 0;
      const highWater = new Map<string, number>();
      for (const head of heads) {
        const { rows: streamRows } = await client.query(
          `SELECT ${PENDING_EVENT_COLUMNS} FROM events
            WHERE aggregate_id = $1 AND version >= $2
            ORDER BY version ASC`,
          [head.aggregate_id, head.version],
        );
        let expected = head.version;
        for (const row of streamRows as PendingEventRow[]) {
          if (row.version !== expected) {
            // 不该发生：同流追加被行锁串行 + 唯一约束，前缀必然连续。
            throw new Error(
              `stream gap while consuming '${head.aggregate_id}': expected v${expected}, saw v${row.version}`,
            );
          }
          const event = this.toStoredEvent(row);
          await this.applyEvent(client, event);
          highWater.set(event.aggregateId, event.version);
          expected += 1;
          processed += 1;
        }
      }

      await this.upsertStreamCheckpoints(client, highWater);
      const watermark = await this.computeGlobalWatermark(client);
      await this.writeGlobalCheckpoint(client, watermark);
      await client.query('COMMIT');
      return processed;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  private toStoredEvent(row: PendingEventRow): StoredEvent {
    return {
      globalSeq: Number(row.global_seq),
      aggregateId: row.aggregate_id,
      aggregateType: ACCOUNT_AGGREGATE_TYPE,
      version: row.version,
      eventType: row.event_type,
      payload: row.payload,
      createdAt: row.created_at.toISOString(),
    };
  }

  /**
   * 全量重放：持有投影互斥锁，在单个事务里清空读模型、
   * 从头消费整条事件流（事务开始时刻的一致快照）重新计算，
   * 再把每流检查点与全局水位写齐。返回处理的事件条数。
   *
   * 与写入并发时：快照里只有重放事务开始前已提交的事件；
   * 重放期间新提交的事件不在快照内，其检查点保持 0，
   * 下一次增量消费会从 v1 补齐这些流，不会漏、也不会重复。
   */
  async replay(): Promise<{ processedEvents: number }> {
    const client = await this.pool.connect();
    try {
      // READ COMMITTED + 投影互斥锁：重放与增量消费不会同时改读模型。
      // 切点 maxSeq 与事件读取放在同一条语句里（MATERIALIZED CTE），
      // 单条 SELECT 在 READ COMMITTED 下使用语句开始时刻的同一快照，
      // 保证"重放到的切点"与"实际读到的事件集"严格一致，即使写入在并发提交。
      await client.query('BEGIN');
      await this.acquireProjectionLock(client);

      await client.query('DELETE FROM projection_accounts');
      await client.query('DELETE FROM projection_stream_checkpoints WHERE projection_name = $1', [
        AccountProjection.NAME,
      ]);

      const { rows: eventRows } = await client.query(
        `WITH cut AS MATERIALIZED (
           SELECT COALESCE(MAX(global_seq), 0) AS max_seq FROM events
         )
         SELECT e.global_seq, e.aggregate_id, e.aggregate_type, e.version, e.event_type, e.payload, e.created_at
           FROM events e CROSS JOIN cut c
          WHERE e.global_seq <= c.max_seq
          ORDER BY e.global_seq ASC`,
      );
      const events: StoredEvent[] = (eventRows as Array<PendingEventRow & { aggregate_type: string }>).map(
        (r) => ({
          globalSeq: Number(r.global_seq),
          aggregateId: r.aggregate_id,
          aggregateType: r.aggregate_type,
          version: r.version,
          eventType: r.event_type,
          payload: r.payload,
          createdAt: r.created_at.toISOString(),
        }),
      );

      // 按聚合流分组、各流内按版本升序应用（账户之间相互独立，跨流顺序无关；
      // 同流必须版本有序）。
      const byStream = new Map<string, StoredEvent[]>();
      for (const event of events) {
        if (event.aggregateType !== ACCOUNT_AGGREGATE_TYPE) continue;
        const list = byStream.get(event.aggregateId) ?? [];
        list.push(event);
        byStream.set(event.aggregateId, list);
      }
      const highWater = new Map<string, number>();
      for (const [aggregateId, streamEvents] of byStream) {
        streamEvents.sort((a, b) => a.version - b.version);
        let expected = 1;
        for (const event of streamEvents) {
          if (event.version !== expected) {
            throw new Error(
              `stream gap during replay for '${aggregateId}': expected v${expected}, saw v${event.version}`,
            );
          }
          await this.applyEvent(client, event);
          expected += 1;
        }
        highWater.set(aggregateId, streamEvents[streamEvents.length - 1].version);
      }

      await this.upsertStreamCheckpoints(client, highWater);
      // 快照中可能还有重放开始后才提交、此刻仍不可见的账户事件；
      // 水位按当前检查点保守计算，不会越过它们。
      const watermark = await this.computeGlobalWatermark(client);
      await this.writeGlobalCheckpoint(client, watermark);

      await client.query('COMMIT');
      let processedEvents = 0;
      for (const list of byStream.values()) processedEvents += list.length;
      return { processedEvents };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** 读模型当前内容 + 汇总 + 与写侧的滞后对比（同一只读事务内取值） */
  async status(): Promise<ProjectionStatus> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN READ ONLY');
      // 注意：同一连接上的查询必须顺序发出（node-postgres 不支持单连接查询流水线并发）。
      const accountRows = (
        await client.query(
          'SELECT aggregate_id, owner, balance_cents, version, updated_at FROM projection_accounts ORDER BY aggregate_id ASC',
        )
      ).rows;
      const checkpointRows = (
        await client.query('SELECT last_global_seq FROM projection_checkpoints WHERE projection_name = $1', [
          AccountProjection.NAME,
        ])
      ).rows;
      const metrics = (
        await client.query(
          `SELECT
               (SELECT COALESCE(MAX(global_seq), 0) FROM events) AS latest_global_seq,
               (SELECT COUNT(*) FROM events e
                  LEFT JOIN projection_stream_checkpoints c
                    ON c.projection_name = $1 AND c.aggregate_id = e.aggregate_id
                 WHERE e.aggregate_type = $2
                   AND e.version > COALESCE(c.last_version, 0)) AS lag_events`,
          [AccountProjection.NAME, ACCOUNT_AGGREGATE_TYPE],
        )
      ).rows[0] as {
        latest_global_seq: string | number;
        lag_events: string | number;
      };
      const laggingRows = (
        await client.query(
        `SELECT a.aggregate_id,
                a.current_version,
                COALESCE(c.last_version, 0) AS processed_version
           FROM aggregates a
           LEFT JOIN projection_stream_checkpoints c
             ON c.projection_name = $1 AND c.aggregate_id = a.aggregate_id
          WHERE a.aggregate_type = $2
            AND a.current_version > COALESCE(c.last_version, 0)
          ORDER BY a.aggregate_id ASC`,
        [AccountProjection.NAME, ACCOUNT_AGGREGATE_TYPE],
      )).rows;
      // 水位在同一快照里现算，再提交；持久化值优先（消费事务真正推进到的位置）。
      const computedWatermark = await this.computeGlobalWatermark(client);
      await client.query('COMMIT');

      const accounts: ProjectionAccountRow[] = (accountRows as ProjectionRow[]).map((row) => ({
        aggregateId: row.aggregate_id,
        owner: row.owner,
        balanceCents: Number(row.balance_cents),
        version: row.version,
        updatedAt: row.updated_at.toISOString(),
      }));
      const lagEvents = Number(metrics.lag_events);
      const latestGlobalSeq = Number(metrics.latest_global_seq);
      // 水位优先取检查点表里持久化的值（代表消费事务真正推进到的位置）；
      // 表里还没有记录（从未消费过）时按当前快照保守现算。
      const lastProcessedSeq =
        checkpointRows.length === 0
          ? computedWatermark
          : Number(checkpointRows[0].last_global_seq);

      return {
        name: AccountProjection.NAME,
        lastProcessedSeq: Math.max(0, lastProcessedSeq),
        latestGlobalSeq,
        lagEvents,
        caughtUp: lagEvents === 0,
        laggingStreams: (laggingRows as Array<{
          aggregate_id: string;
          current_version: number;
          processed_version: number;
        }>).map((r) => ({
          aggregateId: r.aggregate_id,
          currentVersion: r.current_version,
          processedVersion: r.processed_version,
          lagEvents: r.current_version - r.processed_version,
        })),
        accounts,
        summary: {
          totalAccounts: accounts.length,
          totalBalanceCents: accounts.reduce((sum, a) => sum + a.balanceCents, 0),
        },
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}
