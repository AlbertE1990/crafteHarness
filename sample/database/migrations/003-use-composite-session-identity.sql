-- 将 scope_id + session_id 固化为 Session 的数据库主身份。
-- 002 已为旧数据补齐 scope 并建立复合唯一索引；本迁移允许不同 scope 使用相同 session_id。

ALTER TABLE craft_agent_session_events
  DROP CONSTRAINT IF EXISTS craft_agent_session_events_session_id_fkey,
  DROP CONSTRAINT IF EXISTS craft_agent_session_events_scope_session_fkey,
  DROP CONSTRAINT IF EXISTS craft_agent_session_events_scope_not_blank,
  DROP CONSTRAINT IF EXISTS craft_agent_session_events_pkey;

ALTER TABLE craft_agent_sessions
  DROP CONSTRAINT IF EXISTS craft_agent_sessions_scope_not_blank,
  DROP CONSTRAINT IF EXISTS craft_agent_sessions_name_not_blank,
  DROP CONSTRAINT IF EXISTS craft_agent_sessions_pkey;

-- 此时复合外键已移除，可以安全删除随后将被复合主键覆盖的索引。
DROP INDEX IF EXISTS craft_agent_sessions_scope_session_idx;
DROP INDEX IF EXISTS craft_agent_session_events_scope_sequence_idx;

ALTER TABLE craft_agent_sessions
  ADD CONSTRAINT craft_agent_sessions_pkey PRIMARY KEY (scope_id, session_id),
  ADD CONSTRAINT craft_agent_sessions_scope_not_blank
    CHECK (length(btrim(scope_id)) > 0),
  ADD CONSTRAINT craft_agent_sessions_name_not_blank
    CHECK (session_name IS NULL OR length(btrim(session_name)) > 0);

ALTER TABLE craft_agent_session_events
  ADD CONSTRAINT craft_agent_session_events_pkey
    PRIMARY KEY (scope_id, session_id, sequence),
  ADD CONSTRAINT craft_agent_session_events_scope_not_blank
    CHECK (length(btrim(scope_id)) > 0),
  ADD CONSTRAINT craft_agent_session_events_scope_session_fkey
    FOREIGN KEY (scope_id, session_id)
    REFERENCES craft_agent_sessions (scope_id, session_id);
