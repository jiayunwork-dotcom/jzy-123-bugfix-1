/**
 * 数据库结构（幂等 DDL，可重复执行）。
 *
 * 表设计要点：
 * - events：事件流，只允许 INSERT。UNIQUE(aggregate_id, version) 是版本连续的兜底约束；
 *   数据库触发器拒绝一切 UPDATE / DELETE / TRUNCATE，从存储层保证"事件不可变、只追加"。
 * - aggregates：聚合登记表。追加事件时对该行 SELECT ... FOR UPDATE，
 *   以此串行化同一聚合上的并发写入，实现乐观并发控制。
 * - snapshots：快照是派生数据（可由事件重算），允许同版本覆盖。
 * - projection_accounts / projection_checkpoints / projection_stream_positions：
 *   读模型，与写模型完全分离。checkpoint 行做投影操作的全局行锁 + 高水位；
 *   stream_positions 记录每个聚合流各自消费到的版本（按流消费，不依赖全局序号前缀）。
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
  -- 该投影"实际应用过的事件"的最大全局序号（注意：不再是"之前所有序号都已处理"的承诺，
  -- 是否追平请看 lag_events / caught_up；这行同时承担投影操作的全局串行化行锁）
  last_global_seq BIGINT NOT NULL DEFAULT 0
);

-- 每个投影 × 每个聚合一条消费位点（按聚合流独立消费的检查点）。
-- 增量消费按"聚合内版本号"推进，而不是按 events.global_seq 的全局前缀推进：
-- 见 docs/projection-consistency.md（global_seq 在 INSERT 时取号、在 COMMIT 时可见，
-- 跨聚合并发下二者顺序不一致，按全局前缀推进会永久跳过晚提交的事件）。
CREATE TABLE IF NOT EXISTS projection_stream_positions (
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
