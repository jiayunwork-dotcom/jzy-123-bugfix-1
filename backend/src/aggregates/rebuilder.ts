import type { EventStore } from '../events/eventStore.js';
import type { SnapshotStore } from '../events/snapshotStore.js';
import type { StoredEvent } from '../events/types.js';
import { AggregateNotFoundError, VersionOutOfRangeError } from '../errors.js';

export interface RebuildResult<S> {
  /** 重建出的状态 */
  state: S;
  /** 重建到的版本（等于最后一条被应用的事件版本） */
  version: number;
  /** 本次重建是否基于快照；基于的话快照打在哪个版本 */
  snapshotUsed: { version: number } | null;
  /** 本次重建实际回放的事件条数（不含快照覆盖的部分） */
  eventsApplied: number;
}

/**
 * 通用聚合重建器。
 *
 * 算法：找到不超过目标版本的最近快照作为起点，再顺序回放其后的剩余事件。
 * 快照只是性能优化 —— 无论起点是快照还是空状态，只要事件流相同，
 * 重建结果就必须逐字段一致（该不变量由测试锁定）。
 *
 * 回放过程中逐条校验版本连续性：若事件流出现空洞（version 不连续）立即报错，
 * 绝不带着残缺的历史继续重建。
 */
export async function rebuildAggregate<S, E>(
  deps: { eventStore: EventStore; snapshotStore: SnapshotStore },
  aggregateId: string,
  initialState: S,
  evolve: (state: S, event: E) => S,
  toEvent: (stored: StoredEvent) => E,
  targetVersion?: number,
): Promise<RebuildResult<S>> {
  const currentVersion = await deps.eventStore.getCurrentVersion(aggregateId);
  if (currentVersion === null) throw new AggregateNotFoundError(aggregateId);

  const target = targetVersion ?? currentVersion;
  if (!Number.isInteger(target) || target < 0 || target > currentVersion) {
    throw new VersionOutOfRangeError(aggregateId, target as number, currentVersion);
  }

  const snapshot = await deps.snapshotStore.getLatest(aggregateId, target);
  let state = initialState;
  let version = 0;
  let snapshotUsed: { version: number } | null = null;
  if (snapshot) {
    state = snapshot.state as S;
    version = snapshot.version;
    snapshotUsed = { version: snapshot.version };
  }

  // 快照可能正好打在目标版本上，此时无需再回放任何事件
  const events = version >= target ? [] : await deps.eventStore.loadEvents(aggregateId, version + 1, target);
  for (const stored of events) {
    if (stored.version !== version + 1) {
      throw new Error(
        `event stream gap detected for aggregate '${aggregateId}': ` +
          `expected version ${version + 1} but found ${stored.version}`,
      );
    }
    state = evolve(state, toEvent(stored));
    version = stored.version;
  }

  return { state, version, snapshotUsed, eventsApplied: events.length };
}
