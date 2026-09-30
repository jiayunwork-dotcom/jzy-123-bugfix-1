/** 待追加的新事件（版本号由事件存储在追加时分配） */
export interface NewEvent {
  eventType: string;
  payload: unknown;
}

/** 已落库的事件：不可变，带聚合内连续版本号与全局序号 */
export interface StoredEvent {
  /** 全局递增序号，决定跨聚合的全局消费顺序（投影按它消费） */
  globalSeq: number;
  aggregateId: string;
  aggregateType: string;
  /** 聚合内版本号：从 1 开始，严格递增且连续 */
  version: number;
  eventType: string;
  payload: unknown;
  createdAt: string;
}

/** 快照：到某个版本为止重建出的状态（派生数据，可随时重算） */
export interface Snapshot {
  aggregateId: string;
  version: number;
  state: unknown;
  createdAt: string;
}

/** 聚合登记信息（写侧元数据） */
export interface AggregateInfo {
  aggregateId: string;
  aggregateType: string;
  currentVersion: number;
  createdAt: string;
}
