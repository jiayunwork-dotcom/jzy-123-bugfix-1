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
  /**
   * 已实际应用过的事件的最大全局序号（保留字段：语义为"高水位"）。
   * 注意它不再承诺"之前的每个序号都已应用"——跨聚合并发下全局序号的取号顺序
   * 与提交可见顺序不一致。是否真的追平请看 caughtUp / lagEvents。
   */
  lastProcessedSeq: number;
  /** 写侧事件总数（events 表当前行数） */
  eventTotal: number;
  /** 读模型已应用的事件条数（各聚合流位点之和） */
  processedEvents: number;
  /** eventTotal - processedEvents；> 0 即读模型落后（跟进失败 / 在途写入 / 重放中） */
  lagEvents: number;
  /** 已应用条数是否已等于事件总数（按条数判断，不看高水位，杜绝"位点追上但漏事件"） */
  caughtUp: boolean;
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

const PG_SERIALIZATION_FAILURE = '40001';
/**
 * 拿投影锁时的 40001 重试预算。写后跟进在 40+ 账户并发时会形成"抢锁队伍"：
 * 一次全量增量消费可能处理上千条事件、持锁较久，排队者用带抖动的退避等锁，
 * 而不是忙等刷爆数据库。100 次 × 均摊几毫秒到几十毫秒，对正常负载绰绰有余；
 * 真耗尽时抛出错误，由调用方的下一次写后跟进 / 兜底轮询重试，读模型只暂时落后。
 */
const LOCK_RETRY_LIMIT = 100;
const LOCK_RETRY_BASE_DELAY_MS = 2;
const LOCK_RETRY_MAX_DELAY_MS = 100;

function isSerializationFailure(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === PG_SERIALIZATION_FAILURE;
}

function lockRetryDelay(attempt: number): number {
  const expo = Math.min(LOCK_RETRY_MAX_DELAY_MS, LOCK_RETRY_BASE_DELAY_MS * 2 ** Math.min(attempt, 10));
  // 全抖动（full jitter）：打散同时被唤醒的排队者
  return Math.random() * expo;
}

/**
 * 账户读模型投影（CQRS 的读侧）。
 *
 * 两种消费方式，结果必须完全一致（框架最要命的不变量，由测试锁定）：
 * - processNewEvents()：增量消费 —— 按【聚合流】把每个聚合从已消费版本补到当前版本；
 * - replay()：全量重放 —— 清空读模型，在单个一致性快照上从头消费整条事件流重新算。
 *
 * 消费依据是 (aggregate_id, version) 而不是 events.global_seq 的全局前缀：global_seq
 * 在 INSERT 执行时取号、事务 COMMIT 后才对其它事务可见，跨聚合并发下取号顺序与提交
 * 可见顺序不一致，按全局前缀推进检查点会永久跳过晚提交的事件（事故复盘与方案对比见
 * docs/projection-consistency.md）。单聚合内部由 aggregates 行锁串行化追加，版本号在
 * 提交顺序上严格递增连续、永无空洞，所以按流消费不会漏。
 *
 * 并发模型：所有消费动作（增量 / 重放）都是单个 REPEATABLE READ 事务，第一条语句
 * 对 projection_checkpoints 主行 SELECT ... FOR UPDATE 拍下快照并取得全局互斥锁。
 * 排队者的快照若早于前持锁者的提交，FOR UPDATE 会收到 40001 —— 整个事务重试，
 * 新快照必在前驱提交之后，所见即前驱成果 + 之后的新提交。拿到锁之后投影行只可能被
 * 自己改（其它投影事务都在等锁，写事务只写 events/aggregates），故锁内不再有竞争。
 */
export class AccountProjection {
  static readonly NAME = 'account_projection';

  constructor(
    private readonly pool: Pool,
    private readonly eventStore: EventStore,
  ) {}

  /** 把一条事件应用到读模型（在调用方的事务里执行）。账户读模型按版本单调推进。 */
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
        const result = await client.query(
          `UPDATE projection_accounts
             SET balance_cents = balance_cents + $2, version = $3, updated_at = now()
           WHERE aggregate_id = $1`,
          [event.aggregateId, delta, event.version],
        );
        // 防御性不变量：按流消费时 AccountCreated（version 1）必然已在本事务早些时候应用，
        // 账户行不可能缺失。若匹配 0 行，说明"位点/数据"一致性前提被破坏，
        // 显式失败回滚，绝不静默吞掉一条余额变动。
        if (result.rowCount !== 1) {
          throw new Error(
            `projection inconsistency: ${event.eventType} for aggregate '${event.aggregateId}' version ${event.version} matched ${result.rowCount} rows (missing AccountCreated?)`,
          );
        }
        break;
      }
      default:
        // 与账户读模型无关的事件类型直接忽略（流位点仍照常推进）
        break;
    }
  }

  /** 推进某条聚合流的消费位点 */
  private async advanceStreamPosition(client: PoolClient, aggregateId: string, version: number): Promise<void> {
    await client.query(
      `INSERT INTO projection_stream_positions (projection_name, aggregate_id, last_version, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (projection_name, aggregate_id) DO UPDATE
         SET last_version = EXCLUDED.last_version, updated_at = now()`,
      [AccountProjection.NAME, aggregateId, version],
    );
  }

  /**
   * 第一条语句：确保主检查点行存在 + FOR UPDATE 取锁 + 拍下 RR 一致性快照（三者同一刻）。
   * 行的存在性用自动提交的幂等 INSERT 预先保证，这样首次消费不会出现"快照里还没有
   * 检查点行"的竞态。
   */
  private async ensureCheckpointRow(): Promise<void> {
    await this.pool.query(
      `INSERT INTO projection_checkpoints (projection_name, last_global_seq) VALUES ($1, 0)
       ON CONFLICT (projection_name) DO NOTHING`,
      [AccountProjection.NAME],
    );
  }

  /** 取锁 + 快照；返回当前高水位。调用方必须已 BEGIN ISOLATION LEVEL REPEATABLE READ，
   *  且 ensureCheckpointRow() 已执行。 */
  private async lockCheckpointSnapshot(client: PoolClient): Promise<number> {
    const { rows: locked } = await client.query(
      'SELECT last_global_seq FROM projection_checkpoints WHERE projection_name = $1 FOR UPDATE',
      [AccountProjection.NAME],
    );
    return Number(locked[0].last_global_seq);
  }

  /**
   * 增量消费：把每条落后的聚合流从已消费版本补到当前版本（读模型与流位点同事务推进）。
   *
   * 为什么必须 REPEATABLE READ 单快照：READ COMMITTED 下每条语句各取一个新快照，
   * 高并发压测中实测会出现"列出落后聚合"读到 aggregates.current_version=N，而紧接的
   * events 查询看不到该写事务对应事件行的跨语句不一致，于是流位点越过从未应用的版本
   * （存款类 UPDATE 匹配 0 行也不报错），事件被静默永久跳过。单快照下聚合行与事件行
   * 来自同一个已提交状态，所见即所消费；快照之后才提交的写本轮不可见，下轮自然补上。
   *
   * 单聚合内版本严格连续（追加被 aggregates 行锁串行化），读回的必然是 fromVersion+1
   * 起的连续前缀；另加版本连续性断言兜底，绝不带空洞推进位点。
   * 返回本次处理的事件条数。
   */
  async processNewEvents(): Promise<number> {
    await this.ensureCheckpointRow();
    for (let attempt = 1; ; attempt += 1) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        let highWaterMark = await this.lockCheckpointSnapshot(client);

        let processed = 0;
        const lagging = await this.eventStore.listLaggingStreams(AccountProjection.NAME, client);
        for (const aggregateId of lagging) {
          const { rows: posRows } = await client.query(
            'SELECT last_version FROM projection_stream_positions WHERE projection_name = $1 AND aggregate_id = $2',
            [AccountProjection.NAME, aggregateId],
          );
          const fromVersion = posRows.length === 0 ? 0 : Number(posRows[0].last_version);
          const events = await this.eventStore.loadStreamEvents(aggregateId, fromVersion, client);

          let expectedVersion = fromVersion + 1;
          let lastVersion = fromVersion;
          for (const event of events) {
            if (event.version !== expectedVersion) {
              throw new Error(
                `event stream gap detected for aggregate '${aggregateId}': expected version ${expectedVersion} but found ${event.version}`,
              );
            }
            await this.applyEvent(client, event);
            lastVersion = event.version;
            expectedVersion += 1;
            highWaterMark = Math.max(highWaterMark, event.globalSeq);
          }
          if (lastVersion > fromVersion) {
            await this.advanceStreamPosition(client, aggregateId, lastVersion);
          }
          processed += events.length;
        }

        await client.query(
          'UPDATE projection_checkpoints SET last_global_seq = $2 WHERE projection_name = $1',
          [AccountProjection.NAME, highWaterMark],
        );
        await client.query('COMMIT');
        return processed;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        // 排队者的快照早于前持锁者提交 → FOR UPDATE 报 40001：整轮重试，
        // 下一次的快照必在前驱提交之后，不会重复应用（流位点已包含前驱成果）。
        if (isSerializationFailure(err) && attempt <= LOCK_RETRY_LIMIT) {
          await new Promise((resolve) => setTimeout(resolve, lockRetryDelay(attempt)));
          continue;
        }
        throw err;
      } finally {
        client.release();
      }
    }
  }

  /**
   * 全量重放（单个 REPEATABLE READ 事务）：
   * 1. 第一条语句对主检查点行 FOR UPDATE —— 取得与增量消费互斥的锁并同时拍下切点快照；
   * 2. 清空读模型与流位点；
   * 3. 按 (aggregate_id, version) 顺序重放切点内全部事件，重建流位点与高水位；
   * 4. 与读模型同一事务提交。
   * 快照之后才提交（或切点时仍在途）的写入一律留给下一次增量消费，绝不丢、不混半截。
   * 排队者与 processNewEvents 一样在 40001 时整轮重试。
   */
  async replay(): Promise<{ processedEvents: number }> {
    await this.ensureCheckpointRow();
    for (let attempt = 1; ; attempt += 1) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        await this.lockCheckpointSnapshot(client);

        await client.query('DELETE FROM projection_accounts');
        await client.query('DELETE FROM projection_stream_positions WHERE projection_name = $1', [
          AccountProjection.NAME],
        );

        const maxSeq = await this.eventStore.maxGlobalSeq(client);
        const events = await this.eventStore.loadAllEventsUpTo(maxSeq, client);

        // 按聚合分组、流内按版本升序重放。fold 的最终状态只依赖各流内的版本顺序，
        // 流之间的先后不影响结果 —— 这与增量消费"逐流补齐"的结果逐字段相同。
        const byStream = new Map<string, StoredEvent[]>();
        let highWaterMark = 0;
        for (const event of events) {
          const list = byStream.get(event.aggregateId);
          if (list) list.push(event);
          else byStream.set(event.aggregateId, [event]);
          highWaterMark = Math.max(highWaterMark, event.globalSeq);
        }
        for (const [aggregateId, streamEvents] of [...byStream.entries()].sort(([a], [b]) =>
          a < b ? -1 : a > b ? 1 : 0,
        )) {
          streamEvents.sort((a, b) => a.version - b.version);
          for (const event of streamEvents) {
            await this.applyEvent(client, event);
          }
          await this.advanceStreamPosition(client, aggregateId, streamEvents[streamEvents.length - 1].version);
        }

        await client.query(
          `INSERT INTO projection_checkpoints (projection_name, last_global_seq) VALUES ($1, $2)
           ON CONFLICT (projection_name) DO UPDATE SET last_global_seq = EXCLUDED.last_global_seq`,
          [AccountProjection.NAME, highWaterMark],
        );
        await client.query('COMMIT');
        return { processedEvents: events.length };
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        if (isSerializationFailure(err) && attempt <= LOCK_RETRY_LIMIT) {
          await new Promise((resolve) => setTimeout(resolve, lockRetryDelay(attempt)));
          continue;
        }
        throw err;
      } finally {
        client.release();
      }
    }
  }

  /**
   * 读模型当前内容 + 汇总 + 滞后情况。
   * 滞后按"写侧事件总数 vs 已应用条数（流位点之和）"实时计算：跟进失败、在途写入、
   * 重放进行中都会表现为 lagEvents > 0 / caughtUp = false，绝不会再报一个
   * "位点已追平"的假信号。这是观察时刻的非事务性读数，与并发写入相差几条即为真实落后，
   * 下一轮消费（写后跟进 / 兜底轮询）即补齐。
   */
  async status(): Promise<ProjectionStatus> {
    const [{ rows: accountRows }, { rows: statsRows }] = await Promise.all([
      this.pool.query(
        'SELECT aggregate_id, owner, balance_cents, version, updated_at FROM projection_accounts ORDER BY aggregate_id ASC',
      ),
      this.pool.query(
        `SELECT
            (SELECT COUNT(*) FROM events)                                                   AS event_total,
            (SELECT COALESCE(SUM(last_version), 0) FROM projection_stream_positions
              WHERE projection_name = $1)                                                  AS processed_events,
            (SELECT last_global_seq FROM projection_checkpoints WHERE projection_name = $1) AS checkpoint_seq`,
        [AccountProjection.NAME],
      ),
    ]);
    const stats = statsRows[0] as {
      event_total: string | number;
      processed_events: string | number;
      checkpoint_seq: string | number | null;
    };
    const eventTotal = Number(stats.event_total);
    // 已应用条数 = 各流位点之和（账户投影消费全部事件类型）。旧库升级后尚无流位点行时
    // 如实显示为落后，一次增量跟进/重放即补齐。
    const processedEvents = Number(stats.processed_events);
    const lagEvents = Math.max(0, eventTotal - processedEvents);

    const accounts: ProjectionAccountRow[] = (accountRows as ProjectionRow[]).map((row) => ({
      aggregateId: row.aggregate_id,
      owner: row.owner,
      balanceCents: Number(row.balance_cents),
      version: row.version,
      updatedAt: row.updated_at.toISOString(),
    }));
    return {
      name: AccountProjection.NAME,
      lastProcessedSeq: stats.checkpoint_seq === null ? 0 : Number(stats.checkpoint_seq),
      eventTotal,
      processedEvents,
      lagEvents,
      caughtUp: lagEvents === 0,
      accounts,
      summary: {
        totalAccounts: accounts.length,
        totalBalanceCents: accounts.reduce((sum, a) => sum + a.balanceCents, 0),
      },
    };
  }
}
