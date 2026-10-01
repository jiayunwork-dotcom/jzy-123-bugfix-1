import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { ErrorBanner, NoticeBanner } from '../components';
import type { ProjectionStatus } from '../types';
import { describeError, formatCents, formatTime } from '../util';

/**
 * 读模型页：展示投影当前内容，支持"全量重放"——
 * 清空读模型后从头消费整条事件流重新计算，并展示重放结果。
 */
export default function ProjectionPage() {
  const [status, setStatus] = useState<ProjectionStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [replaying, setReplaying] = useState(false);

  const load = useCallback(async () => {
    try {
      setStatus(await api.projectionStatus());
      setError(null);
    } catch (err) {
      setError(describeError(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const replay = async () => {
    setReplaying(true);
    setError(null);
    try {
      const result = await api.replayProjection();
      setStatus(result);
      setNotice(
        `全量重放完成：从头消费了 ${result.processedEvents} 条事件，耗时 ${result.durationMs}ms，` +
          `重建出 ${result.summary.totalAccounts} 个账户视图`,
      );
    } catch (err) {
      setError(describeError(err));
    } finally {
      setReplaying(false);
    }
  };

  return (
    <div>
      <ErrorBanner message={error} onClose={() => setError(null)} />
      <NoticeBanner message={notice} onClose={() => setNotice(null)} />

      <section className="card">
        <div className="card-header">
          <h2>读模型（账户投影）</h2>
          <div>
            <button onClick={() => void load()} disabled={replaying}>
              刷新
            </button>{' '}
            <button className="primary" onClick={() => void replay()} disabled={replaying}>
              {replaying ? '重放中…' : '对读模型做一次全量重放'}
            </button>
          </div>
        </div>
        <p className="hint">
          全量重放会清空读模型、从第一条事件开始重新消费整条事件流。
          按框架的核心不变量，重放结果与增量消费的结果完全一致。
        </p>
        {status && (
          <>
            <p className="hint">
              投影 <span className="mono">{status.name}</span> · 已应用事件高水位 #
              {status.lastProcessedSeq} · 已消费 {status.processedEvents}/{status.eventTotal} 条 · 共{' '}
              {status.summary.totalAccounts} 个账户 · 余额汇总{' '}
              {formatCents(status.summary.totalBalanceCents)}
            </p>
            {status.caughtUp ? (
              <p className="hint" style={{ color: 'var(--success, #1a7f37)' }}>
                ● 读模型已追平：已应用 {status.processedEvents} 条 = 事件总数 {status.eventTotal}
              </p>
            ) : (
              <p className="hint" style={{ color: 'var(--warning, #b26a00)', fontWeight: 600 }}>
                ▲ 读模型落后 {status.lagEvents} 条事件（已应用 {status.processedEvents}/
                {status.eventTotal}）：跟进失败、写入在途或重放进行中都会如此，稍后自动跟进或手动重放即可补齐
              </p>
            )}
            <table>
              <thead>
                <tr>
                  <th>账户 ID</th>
                  <th>户主</th>
                  <th className="num">余额</th>
                  <th className="num">版本</th>
                  <th>最后更新</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {status.accounts.length === 0 && (
                  <tr>
                    <td colSpan={6} className="empty">
                      读模型为空
                    </td>
                  </tr>
                )}
                {status.accounts.map((a) => (
                  <tr key={a.aggregateId}>
                    <td className="mono">{a.aggregateId}</td>
                    <td>{a.owner}</td>
                    <td className="num">{formatCents(a.balanceCents)}</td>
                    <td className="num">v{a.version}</td>
                    <td>{formatTime(a.updatedAt)}</td>
                    <td className="num">
                      <Link to={`/accounts/${encodeURIComponent(a.aggregateId)}`}>详情 →</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </section>
    </div>
  );
}
