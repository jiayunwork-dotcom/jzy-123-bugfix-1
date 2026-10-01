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

export interface ProjectionStatus {
  name: string;
  /** 已实际应用事件的最大全局序号（高水位，不代表此前每个序号都已处理） */
  lastProcessedSeq: number;
  /** 写侧事件总数 */
  eventTotal: number;
  /** 读模型已应用的事件条数 */
  processedEvents: number;
  /** 落后条数（eventTotal - processedEvents） */
  lagEvents: number;
  /** 是否已追平（按条数比较，不看高水位） */
  caughtUp: boolean;
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
