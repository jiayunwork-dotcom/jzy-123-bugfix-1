import {
  ACCOUNT_AGGREGATE_TYPE,
  decideAccount,
  evolveAccount,
  initialAccountState,
  type AccountCommand,
  type AccountEvent,
  type AccountState,
} from '../domain/account.js';
import { AggregateNotFoundError, SnapshotVersionOutOfRangeError } from '../errors.js';
import type { EventStore } from '../events/eventStore.js';
import type { SnapshotStore } from '../events/snapshotStore.js';
import type { Snapshot, StoredEvent } from '../events/types.js';
import type { AccountProjection } from '../projections/accountProjection.js';
import { rebuildAggregate, type RebuildResult } from './rebuilder.js';

export interface CommandResult {
  aggregateId: string;
  /** 追加完成后的最新版本 */
  version: number;
  /** 本次追加落库的事件 */
  events: StoredEvent[];
  /** 追加完成后的最新状态 */
  state: AccountState;
}

/**
 * 账户聚合服务：把"命令 → 校验 → 事件 → 追加 → 读模型跟进"串起来。
 * HTTP 层只调用这里，不直接碰事件存储。
 */
export class AccountService {
  constructor(
    private readonly eventStore: EventStore,
    private readonly snapshotStore: SnapshotStore,
    private readonly projection: AccountProjection,
  ) {}

  /**
   * 执行一条命令：
   * 1. 重建当前状态（自动利用最近快照）；
   * 2. decideAccount 做业务校验并生成事件 —— 不合法在这一步抛错，不会产生任何事件；
   * 3. 以 expectedVersion 做乐观并发追加；版本不符则抛 VERSION_CONFLICT，
   *    由调用方拿最新状态重试；
   * 4. 提交后让读模型增量跟进（读模型失败不影响已提交的写入，可事后重放补齐）。
   */
  async executeCommand(
    aggregateId: string,
    command: AccountCommand,
    expectedVersion: number,
  ): Promise<CommandResult> {
    let current: RebuildResult<AccountState>;
    try {
      current = await this.rebuild(aggregateId);
    } catch (err) {
      // 对不存在的聚合：CreateAccount 按"新建"处理（从空状态起步），其余命令明确拒绝
      if (err instanceof AggregateNotFoundError && command.type === 'CreateAccount') {
        current = { state: initialAccountState, version: 0, snapshotUsed: null, eventsApplied: 0 };
      } else {
        throw err;
      }
    }

    const newEvents = decideAccount(aggregateId, command, current.state);
    const stored = await this.eventStore.append(aggregateId, ACCOUNT_AGGREGATE_TYPE, expectedVersion, newEvents);

    try {
      await this.projection.processNewEvents();
    } catch (err) {
      // 读模型是派生物，滞后可修复；不让它拖垮已成功的写入
      console.error('projection catch-up failed (read model may lag until replay):', err);
    }

    const state = stored.reduce<AccountState>(
      (acc, e) => evolveAccount(acc, e as AccountEvent),
      current.state,
    );
    return { aggregateId, version: stored[stored.length - 1].version, events: stored, state };
  }

  /** 重建某聚合在 targetVersion（缺省为最新）时刻的状态 */
  async rebuild(aggregateId: string, targetVersion?: number): Promise<RebuildResult<AccountState>> {
    return rebuildAggregate<AccountState, AccountEvent>(
      { eventStore: this.eventStore, snapshotStore: this.snapshotStore },
      aggregateId,
      initialAccountState,
      evolveAccount,
      (stored) => ({ eventType: stored.eventType, payload: stored.payload }) as AccountEvent,
      targetVersion,
    );
  }

  /**
   * 手动打快照：重建到指定版本（缺省为当前版本）的状态并落库。
   * 版本必须落在 1..当前版本 区间内，否则报 SNAPSHOT_VERSION_OUT_OF_RANGE。
   */
  async createSnapshot(aggregateId: string, version?: number): Promise<Snapshot> {
    const currentVersion = await this.eventStore.getCurrentVersion(aggregateId);
    if (currentVersion === null) throw new AggregateNotFoundError(aggregateId);

    const v = version ?? currentVersion;
    if (!Number.isInteger(v) || v < 1 || v > currentVersion) {
      throw new SnapshotVersionOutOfRangeError(aggregateId, v as number, currentVersion);
    }

    const { state } = await this.rebuild(aggregateId, v);
    return this.snapshotStore.save(aggregateId, v, state);
  }
}
