/** 与后端 API 对应的类型定义 */

export interface AccountState {
  exists: boolean;
  owner: string | null;
  balanceCents: number;
}

export interface StoredEvent {
  globalSeq: number;
  aggregateId: string;
  aggregateType: string;
  version: number;
  eventType: string;
  payload: unknown;
  createdAt: string;
}

export interface Snapshot {
  aggregateId: string;
  version: number;
  state: unknown;
  createdAt: string;
}

export interface AggregateInfo {
  aggregateId: string;
  aggregateType: string;
  currentVersion: number;
  createdAt: string;
}

export interface StateResponse {
  aggregateId: string;
  state: AccountState;
  version: number;
  snapshotUsed: { version: number } | null;
  eventsApplied: number;
}

export interface CommandResult {
  aggregateId: string;
  version: number;
  events: StoredEvent[];
  state: AccountState;
}

export interface ProjectionAccountRow {
  aggregateId: string;
  owner: string;
  balanceCents: number;
  version: number;
  updatedAt: string;
}

export interface ProjectionLaggingStream {
  aggregateId: string;
  currentVersion: number;
  processedVersion: number;
  lagEvents: number;
}

export interface ProjectionStatus {
  name: string;
  /** 已确定消费完整的全局序号连续前缀上界（保守水位，提交中有事务时会停在其之前） */
  lastProcessedSeq: number;
  /** 写侧当前最大全局序号 */
  latestGlobalSeq: number;
  /** 已提交但读模型尚未消费的事件条数 */
  lagEvents: number;
  /** 读模型是否已追平写侧 */
  caughtUp: boolean;
  /** 逐账户落后明细 */
  laggingStreams: ProjectionLaggingStream[];
  accounts: ProjectionAccountRow[];
  summary: {
    totalAccounts: number;
    totalBalanceCents: number;
  };
}

export interface ReplayResult extends ProjectionStatus {
  processedEvents: number;
  durationMs: number;
}

export type AccountCommand =
  | { type: 'CreateAccount'; owner: string; initialBalanceCents?: number }
  | { type: 'DepositMoney'; amountCents: number }
  | { type: 'WithdrawMoney'; amountCents: number };
