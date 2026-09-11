-- CraftAgent Session Log 的 PostgreSQL 基础结构。
-- 本迁移只描述通用会话协议，不加入 user_id、tenant_id 等应用字段。

CREATE TABLE IF NOT EXISTS craft_agent_sessions (
  session_id text PRIMARY KEY,
  catalog_order bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  metadata_json jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT craft_agent_sessions_id_not_blank
    CHECK (length(btrim(session_id)) > 0),
  CONSTRAINT craft_agent_sessions_metadata_is_object
    CHECK (metadata_json IS NULL OR jsonb_typeof(metadata_json) = 'object')
);

CREATE INDEX IF NOT EXISTS craft_agent_sessions_created_idx
  ON craft_agent_sessions (catalog_order);

CREATE TABLE IF NOT EXISTS craft_agent_session_events (
  session_id text NOT NULL
    REFERENCES craft_agent_sessions(session_id),
  sequence bigint NOT NULL CHECK (sequence > 0),
  event_id text NOT NULL UNIQUE,
  event_type varchar(64) NOT NULL,
  run_id text,
  turn_id text,
  payload_json jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (session_id, sequence),
  CONSTRAINT craft_agent_session_events_id_not_blank
    CHECK (length(btrim(event_id)) > 0),
  CONSTRAINT craft_agent_session_events_type_not_blank
    CHECK (length(btrim(event_type)) > 0),
  CONSTRAINT craft_agent_session_events_payload_is_object
    CHECK (jsonb_typeof(payload_json) = 'object')
);

CREATE INDEX IF NOT EXISTS craft_agent_session_events_run_idx
  ON craft_agent_session_events (run_id)
  WHERE run_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS craft_agent_session_events_turn_idx
  ON craft_agent_session_events (session_id, turn_id, sequence)
  WHERE turn_id IS NOT NULL;
