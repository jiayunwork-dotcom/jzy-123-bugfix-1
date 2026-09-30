import { FormEvent, useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../api';
import { ErrorBanner, NoticeBanner } from '../components';
import type { Snapshot, StateResponse, StoredEvent } from '../types';
import { describeError, formatCents, formatTime, parseYuanToCents } from '../util';

const EVENT_LABELS: Record<string, string> = {
  AccountCreated: '创建账户',
  MoneyDeposited: '存款',
  MoneyWithdrawn: '取款',
};

/**
 * 聚合详情页：
 * - 当前状态（由后端从事件流重建，标明是否基于快照）
 * - 追加新事件（存 / 取款命令，携带 expectedVersion 做乐观并发）
 * - 手动打快照、查看快照列表
 * - 完整事件时间线，支持按版本区间查询
 * - 查询任意历史版本的状态
 */
export default function AccountDetailPage() {
  const { id = '' } = useParams();

  const [state, setState] = useState<StateResponse | null>(null);
  const [events, setEvents] = useState<StoredEvent[]>([]);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [amount, setAmount] = useState('');
  const [snapshotVersion, setSnapshotVersion] = useState('');
  const [range, setRange] = useState({ from: '', to: '' });
  const [atVersion, setAtVersion] = useState('');
  const [historical, setHistorical] = useState<StateResponse | null>(null);

  const load = useCallback(async () => {
    try {
      const [s, e, snaps] = await Promise.all([
        api.getState(id),
        api.getEvents(id),
        api.listSnapshots(id),
      ]);
      setState(s);
      setEvents(e.events);
      setSnapshots(snaps.snapshots);
      setNotFound(false);
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'AGGREGATE_NOT_FOUND') {
        setNotFound(true);
      } else {
        setError(describeError(err));
      }
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  /** 追加一条新事件（存款 / 取款命令）。expectedVersion 始终取当前最新版本。 */
  const runCommand = async (type: 'DepositMoney' | 'WithdrawMoney') => {
    if (!state) return;
    setError(null);
    setNotice(null);
    try {
      const amountCents = parseYuanToCents(amount);
      if (amountCents <= 0) throw new Error('金额必须大于 0');
      const result = await api.sendCommand(id, { type, amountCents }, state.version);
      setNotice(
        `${EVENT_LABELS[type]}成功：已追加事件 v${result.version}，当前余额 ${formatCents(result.state.balanceCents)}`,
      );
      setAmount('');
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'VERSION_CONFLICT') {
        setError('版本冲突：有人在你之前写入了这个账户，已自动刷新到最新状态，请重试。');
        await load();
      } else {
        setError(describeError(err));
      }
    }
  };

  const takeSnapshot = async (ev: FormEvent) => {
    ev.preventDefault();
    setError(null);
    setNotice(null);
    try {
      const version = snapshotVersion.trim() === '' ? undefined : Number(snapshotVersion);
      if (version !== undefined && !Number.isInteger(version)) throw new Error('快照版本必须是整数');
      const { snapshot } = await api.createSnapshot(id, version);
      setNotice(`已在版本 v${snapshot.version} 打快照`);
      setSnapshotVersion('');
      await load();
    } catch (err) {
      setError(describeError(err));
    }
  };

  const queryRange = async (ev: FormEvent) => {
    ev.preventDefault();
    setError(null);
    try {
      const from = range.from.trim() === '' ? undefined : Number(range.from);
      const to = range.to.trim() === '' ? undefined : Number(range.to);
      const result = await api.getEvents(id, from, to);
      setEvents(result.events);
    } catch (err) {
      setError(describeError(err));
    }
  };

  const queryHistorical = async (ev: FormEvent) => {
    ev.preventDefault();
    setError(null);
    setHistorical(null);
    try {
      const v = Number(atVersion);
      if (!Number.isInteger(v) || v < 0) throw new Error('版本必须是不为负的整数');
      setHistorical(await api.getState(id, v));
    } catch (err) {
      setError(describeError(err));
    }
  };

  if (notFound) {
    return (
      <div className="card">
        <p>
          聚合 <span className="mono">{id}</span> 不存在。
        </p>
        <p>
          <Link to="/">← 返回账户列表</Link>
        </p>
      </div>
    );
  }

  return (
    <div>
      <p>
        <Link to="/">← 返回账户列表</Link>
      </p>
      <ErrorBanner message={error} onClose={() => setError(null)} />
      <NoticeBanner message={notice} onClose={() => setNotice(null)} />

      <section className="card">
        <div className="card-header">
          <h2>
            账户 <span className="mono">{id}</span>
          </h2>
          <button onClick={() => void load()}>刷新</button>
        </div>
        {state && (
          <div className="state-grid">
            <div>
              <div className="stat-label">户主</div>
              <div className="stat-value">{state.state.owner}</div>
            </div>
            <div>
              <div className="stat-label">当前余额</div>
              <div className="stat-value">{formatCents(state.state.balanceCents)}</div>
            </div>
            <div>
              <div className="stat-label">当前版本</div>
              <div className="stat-value">v{state.version}</div>
            </div>
            <div>
              <div className="stat-label">本次重建方式</div>
              <div className="stat-value">
                {state.snapshotUsed
                  ? `快照 v${state.snapshotUsed.version} + 回放 ${state.eventsApplied} 条事件`
                  : `全量重放（${state.eventsApplied} 条事件）`}
              </div>
            </div>
          </div>
        )}
      </section>

      <section className="card">
        <h2>追加新事件（存 / 取款）</h2>
        <p className="hint">
          提交时携带 expectedVersion = 当前版本（v{state?.version ?? '—'}）。
          若期间有他人先写入，后端会拒绝并返回 409 版本冲突。
        </p>
        <div className="form-row">
          <label>
            金额（元）
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="100.00"
              inputMode="decimal"
            />
          </label>
          <button className="primary" onClick={() => void runCommand('DepositMoney')} disabled={!state}>
            存款
          </button>
          <button className="primary" onClick={() => void runCommand('WithdrawMoney')} disabled={!state}>
            取款
          </button>
        </div>
      </section>

      <section className="card">
        <h2>快照</h2>
        <form className="form-row" onSubmit={takeSnapshot}>
          <label>
            版本（留空 = 当前版本 v{state?.version ?? '—'}）
            <input
              value={snapshotVersion}
              onChange={(e) => setSnapshotVersion(e.target.value)}
              placeholder={String(state?.version ?? '')}
              inputMode="numeric"
            />
          </label>
          <button type="submit" disabled={!state}>
            手动打快照
          </button>
        </form>
        {snapshots.length > 0 && (
          <table>
            <thead>
              <tr>
                <th className="num">快照版本</th>
                <th>状态</th>
                <th>创建时间</th>
              </tr>
            </thead>
            <tbody>
              {snapshots.map((s) => (
                <tr key={s.version}>
                  <td className="num">v{s.version}</td>
                  <td className="mono small">{JSON.stringify(s.state)}</td>
                  <td>{formatTime(s.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <h2>历史状态查询</h2>
        <form className="form-row" onSubmit={queryHistorical}>
          <label>
            版本号
            <input
              value={atVersion}
              onChange={(e) => setAtVersion(e.target.value)}
              placeholder="1"
              inputMode="numeric"
            />
          </label>
          <button type="submit">重建该版本状态</button>
        </form>
        {historical && (
          <p className="hint">
            v{historical.version} 时刻：余额 {formatCents(historical.state.balanceCents)}（
            {historical.snapshotUsed
              ? `基于快照 v${historical.snapshotUsed.version} 重建`
              : '从头全量重放'}
            ）
          </p>
        )}
      </section>

      <section className="card">
        <div className="card-header">
          <h2>事件时间线</h2>
          <form className="form-inline" onSubmit={queryRange}>
            <input
              className="narrow"
              value={range.from}
              onChange={(e) => setRange({ ...range, from: e.target.value })}
              placeholder="从版本"
              inputMode="numeric"
            />
            <input
              className="narrow"
              value={range.to}
              onChange={(e) => setRange({ ...range, to: e.target.value })}
              placeholder="到版本"
              inputMode="numeric"
            />
            <button type="submit">按区间查询</button>
            <button
              type="button"
              onClick={() => {
                setRange({ from: '', to: '' });
                void load();
              }}
            >
              重置
            </button>
          </form>
        </div>
        <table>
          <thead>
            <tr>
              <th className="num">版本</th>
              <th>事件类型</th>
              <th>内容</th>
              <th className="num">全局序号</th>
              <th>时间</th>
            </tr>
          </thead>
          <tbody>
            {events.length === 0 && (
              <tr>
                <td colSpan={5} className="empty">
                  该区间内没有事件
                </td>
              </tr>
            )}
            {events.map((e) => (
              <tr key={e.version}>
                <td className="num">v{e.version}</td>
                <td>
                  <span className={`tag tag-${e.eventType}`}>{EVENT_LABELS[e.eventType] ?? e.eventType}</span>
                </td>
                <td className="mono small">{JSON.stringify(e.payload)}</td>
                <td className="num">#{e.globalSeq}</td>
                <td>{formatTime(e.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
