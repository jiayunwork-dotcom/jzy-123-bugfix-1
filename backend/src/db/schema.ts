/**
 * 数据库结构（幂等 DDL，可重复执行）。
 *
 * 表设计要点：
 * - events：事件流，只允许 INSERT。UNIQUE(aggregate_id, version) 是版本连续的兜底约束；
 *   数据库触发器拒绝一切 UPDATE / DELETE / TRUNCATE，从存储层保证"事件不可变、只追加"。
 * - aggregates：聚合登记表。追加事件时对该行 SELECT ... FOR UPDATE，
 *   以此串行化同一聚合上的并发写入，实现乐观并发控制。
 * - snapshots：快照是派生数据（可由事件重算），允许同版本覆盖。
 * - projection_accounts / projection_checkpoints：读模型，与写模型完全分离。
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS aggregates (
  aggregate_id    TEXT PRIMARY KEY,
  aggregate_type  TEXT NOT NULL,
  current_version INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS events (
  global_seq     BIGSERIAL PRIMARY KEY,
  aggregate_id   TEXT NOT NULL REFERENCES aggregates (aggregate_id),
  aggregate_type TEXT NOT NULL,
  version        INTEGER NOT NULL,
  event_type     TEXT NOT NULL,
  payload        JSONB NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT events_aggregate_version_unique UNIQUE (aggregate_id, version)
);

CREATE INDEX IF NOT EXISTS events_aggregate_idx ON events (aggregate_id, version);

CREATE TABLE IF NOT EXISTS snapshots (
  aggregate_id TEXT NOT NULL REFERENCES aggregates (aggregate_id),
  version      INTEGER NOT NULL,
  state        JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (aggregate_id, version)
);

CREATE TABLE IF NOT EXISTS projection_accounts (
  aggregate_id  TEXT PRIMARY KEY,
  owner         TEXT NOT NULL,
  balance_cents BIGINT NOT NULL,
  version       INTEGER NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS projection_checkpoints (
  projection_name TEXT PRIMARY KEY,
  -- 保守的全局水位：读模型已确定"吃满"的 global_seq 连续前缀上界。
  -- 注意它不是"见过的最大 seq"：并发提交会让较大 seq 先可见、较小 seq 还在
  -- 别的事务里没提交，越过去推进就会永久丢事件。该值只推进到最小的未消费
  -- （或尚不可见）账户事件 seq 之前。
  last_global_seq BIGINT NOT NULL DEFAULT 0
);

-- 每聚合流检查点：投影按"聚合内连续版本号"消费，而不是按全局序号。
-- 同一聚合的追加在 aggregates 行锁下串行，UNIQUE(aggregate_id, version)
-- 兜底，因此每个聚合流的版本号严格连续，且"提交顺序 == 可见顺序"：
-- 一个流里永远不会出现 v3 已提交可见、而 v2 还在未提交事务里的情况。
-- 这使得按流推进不可能跳过任何最终提交的事件 —— 这正是旧的"按 global_seq
-- 消费"在跨聚合并发提交下做不到的（global_seq 在 INSERT 时、而非 COMMIT 时
-- 分配，序号顺序与可见顺序不一致）。
CREATE TABLE IF NOT EXISTS projection_stream_checkpoints (
  projection_name TEXT NOT NULL,
  aggregate_id    TEXT NOT NULL,
  last_version    INTEGER NOT NULL DEFAULT 0,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (projection_name, aggregate_id)
);

CREATE OR REPLACE FUNCTION reject_event_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'events are immutable: % on table "events" is not allowed', TG_OP;
END;
$$;

DROP TRIGGER IF EXISTS events_immutable ON events;
CREATE TRIGGER events_immutable
  BEFORE UPDATE OR DELETE ON events
  FOR EACH ROW EXECUTE FUNCTION reject_event_mutation();

DROP TRIGGER IF EXISTS events_no_truncate ON events;
CREATE TRIGGER events_no_truncate
  BEFORE TRUNCATE ON events
  FOR EACH STATEMENT EXECUTE FUNCTION reject_event_mutation();
`;
