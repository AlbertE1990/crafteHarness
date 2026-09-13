-- Sample Runtime 的完整 Agent 轨迹旁路存储。
-- 它不属于 craft-harness 的 SessionStore 协议；会话删除时由复合外键级联清理。

CREATE TABLE IF NOT EXISTS craft_agent_trace_events (
  scope_id text NOT NULL,
  session_id text NOT NULL,
  trace_sequence bigint GENERATED ALWAYS AS IDENTITY,
  run_id text NOT NULL,
  turn_id text NOT NULL,
  event_type varchar(64) NOT NULL,
  payload_json jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (scope_id, session_id, trace_sequence),
  CONSTRAINT craft_agent_trace_events_scope_session_fkey
    FOREIGN KEY (scope_id, session_id)
    REFERENCES craft_agent_sessions (scope_id, session_id)
    ON DELETE CASCADE,
  CONSTRAINT craft_agent_trace_events_scope_not_blank
    CHECK (length(btrim(scope_id)) > 0),
  CONSTRAINT craft_agent_trace_events_type_not_blank
    CHECK (length(btrim(event_type)) > 0),
  CONSTRAINT craft_agent_trace_events_payload_is_object
    CHECK (jsonb_typeof(payload_json) = 'object')
);

CREATE INDEX IF NOT EXISTS craft_agent_trace_events_session_sequence_idx
  ON craft_agent_trace_events (scope_id, session_id, trace_sequence DESC);

CREATE INDEX IF NOT EXISTS craft_agent_trace_events_run_idx
  ON craft_agent_trace_events (scope_id, session_id, run_id, trace_sequence);
