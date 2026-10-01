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
              投影 <span className="mono">{status.name}</span> · 安全水位 #
              {status.lastProcessedSeq} / 写侧最新 #{status.latestGlobalSeq} · 共{' '}
              {status.summary.totalAccounts} 个账户 · 余额汇总{' '}
              {formatCents(status.summary.totalBalanceCents)}
            </p>
            {!status.caughtUp && (
              <p className="hint" style={{ color: '#b54708' }}>
                ⚠ 读模型落后：还有 {status.lagEvents} 条已提交事件未消费
                {status.laggingStreams.length > 0 && (
                  <>
                    {' '}
                    （账户：
                    {status.laggingStreams
                      .slice(0, 10)
                      .map(
                        (s) =>
                          `${s.aggregateId} 缺 ${s.lagEvents} 条（v${s.processedVersion}→v${s.currentVersion}）`,
                      )
                      .join('；')}
                    {status.laggingStreams.length > 10 ? ' …' : ''}）
                  </>
                )}
                ；可点"全量重放"立即修复，或等待下一次写入触发增量跟进。
              </p>
            )}
            {status.caughtUp && status.lastProcessedSeq < status.latestGlobalSeq && (
              <p className="hint">
                已提交事件已全部消费（无落后）；写侧有提交中的事务，安全水位暂停在 #
                {status.lastProcessedSeq}，待其提交后下一次跟进即前移，期间不会漏事件。
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
