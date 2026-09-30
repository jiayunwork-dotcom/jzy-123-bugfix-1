import { FormEvent, useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { ErrorBanner, NoticeBanner } from '../components';
import type { ProjectionStatus } from '../types';
import { describeError, formatCents } from '../util';

/**
 * 账户列表页：数据完全来自读模型投影（CQRS 读侧），
 * 展示所有聚合的当前状态与余额汇总，并提供"创建账户"入口。
 */
export default function AccountListPage() {
  const [status, setStatus] = useState<ProjectionStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState({ id: '', owner: '', initial: '' });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setStatus(await api.projectionStatus());
      setError(null);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const createAccount = async (ev: FormEvent) => {
    ev.preventDefault();
    setError(null);
    setNotice(null);
    try {
      const id = form.id.trim() || `acct-${Date.now().toString(36)}`;
      const initialBalanceCents = form.initial.trim() === '' ? 0 : parseInitialCents(form.initial);
      await api.sendCommand(id, { type: 'CreateAccount', owner: form.owner, initialBalanceCents }, 0);
      setNotice(`账户 ${id} 创建成功（版本 1）`);
      setForm({ id: '', owner: '', initial: '' });
      await load();
    } catch (err) {
      setError(describeError(err));
    }
  };

  return (
    <div>
      <ErrorBanner message={error} onClose={() => setError(null)} />
      <NoticeBanner message={notice} onClose={() => setNotice(null)} />

      <section className="cards">
        <div className="card stat">
          <div className="stat-label">账户总数</div>
          <div className="stat-value">{status?.summary.totalAccounts ?? '—'}</div>
        </div>
        <div className="card stat">
          <div className="stat-label">余额汇总</div>
          <div className="stat-value">{status ? formatCents(status.summary.totalBalanceCents) : '—'}</div>
        </div>
        <div className="card stat">
          <div className="stat-label">投影已消费到全局序号</div>
          <div className="stat-value">{status?.lastProcessedSeq ?? '—'}</div>
        </div>
      </section>

      <section className="card">
        <div className="card-header">
          <h2>账户列表（来自读模型投影）</h2>
          <button onClick={() => void load()} disabled={loading}>
            {loading ? '刷新中…' : '刷新'}
          </button>
        </div>
        <table>
          <thead>
            <tr>
              <th>账户 ID</th>
              <th>户主</th>
              <th className="num">余额</th>
              <th className="num">当前版本</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {status?.accounts.length === 0 && (
              <tr>
                <td colSpan={5} className="empty">
                  还没有账户，先在下面创建一个
                </td>
              </tr>
            )}
            {status?.accounts.map((a) => (
              <tr key={a.aggregateId}>
                <td className="mono">{a.aggregateId}</td>
                <td>{a.owner}</td>
                <td className="num">{formatCents(a.balanceCents)}</td>
                <td className="num">v{a.version}</td>
                <td className="num">
                  <Link to={`/accounts/${encodeURIComponent(a.aggregateId)}`}>详情 →</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card">
        <h2>创建账户</h2>
        <form className="form-row" onSubmit={createAccount}>
          <label>
            账户 ID（留空自动生成）
            <input
              value={form.id}
              onChange={(e) => setForm({ ...form, id: e.target.value })}
              placeholder="acct-001"
            />
          </label>
          <label>
            户主
            <input
              required
              value={form.owner}
              onChange={(e) => setForm({ ...form, owner: e.target.value })}
              placeholder="张三"
            />
          </label>
          <label>
            初始余额（元）
            <input
              value={form.initial}
              onChange={(e) => setForm({ ...form, initial: e.target.value })}
              placeholder="0.00"
              inputMode="decimal"
            />
          </label>
          <button type="submit" className="primary">
            创建
          </button>
        </form>
      </section>
    </div>
  );
}

function parseInitialCents(input: string): number {
  const n = Number(input.trim());
  if (!Number.isFinite(n)) throw new Error('初始余额必须是数字');
  const cents = Math.round(n * 100);
  if (!Number.isSafeInteger(cents) || cents < 0) throw new Error('初始余额必须是不为负的数');
  return cents;
}
