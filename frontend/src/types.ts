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
  lastProcessedSeq: number;
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
