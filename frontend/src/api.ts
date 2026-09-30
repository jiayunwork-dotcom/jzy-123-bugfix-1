import type {
  AccountCommand,
  AggregateInfo,
  CommandResult,
  ProjectionStatus,
  ReplayResult,
  Snapshot,
  StateResponse,
  StoredEvent,
} from './types';

/** 后端返回的业务错误（code 与后端约定一致） */
export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = data?.error;
    throw new ApiError(err?.code ?? 'UNKNOWN', err?.message ?? res.statusText, res.status, err?.details);
  }
  return data as T;
}

const enc = encodeURIComponent;

/** 前端只做取数与展示，所有业务计算都在后端 */
export const api = {
  listAggregates: () => request<{ aggregates: AggregateInfo[] }>('/aggregates'),

  getState: (id: string, atVersion?: number) =>
    request<StateResponse>(
      `/aggregates/${enc(id)}/state${atVersion !== undefined ? `?atVersion=${atVersion}` : ''}`,
    ),

  getEvents: (id: string, fromVersion?: number, toVersion?: number) => {
    const params = new URLSearchParams();
    if (fromVersion !== undefined) params.set('fromVersion', String(fromVersion));
    if (toVersion !== undefined) params.set('toVersion', String(toVersion));
    const qs = params.toString();
    return request<{ aggregateId: string; events: StoredEvent[] }>(
      `/aggregates/${enc(id)}/events${qs ? `?${qs}` : ''}`,
    );
  },

  sendCommand: (id: string, command: AccountCommand, expectedVersion: number) =>
    request<CommandResult>(`/aggregates/${enc(id)}/commands`, {
      method: 'POST',
      body: JSON.stringify({ command, expectedVersion }),
    }),

  createSnapshot: (id: string, version?: number) =>
    request<{ snapshot: Snapshot }>(`/aggregates/${enc(id)}/snapshots`, {
      method: 'POST',
      body: JSON.stringify(version !== undefined ? { version } : {}),
    }),

  listSnapshots: (id: string) =>
    request<{ snapshots: Snapshot[] }>(`/aggregates/${enc(id)}/snapshots`),

  projectionStatus: () => request<ProjectionStatus>('/projection/accounts'),

  replayProjection: () => request<ReplayResult>('/projection/accounts/replay', { method: 'POST' }),
};
