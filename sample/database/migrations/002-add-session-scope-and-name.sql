-- 为 Session Catalog 增加显式作用域和标准可搜索名称。
-- 旧数据进入单用户 default 作用域；旧 metadata.name 只用于一次性回填名称。

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;

ALTER TABLE craft_agent_sessions
  ADD COLUMN IF NOT EXISTS scope_id text,
  ADD COLUMN IF NOT EXISTS session_name text;

UPDATE craft_agent_sessions
SET scope_id = 'default'
WHERE scope_id IS NULL;

UPDATE craft_agent_sessions
SET session_name = NULLIF(btrim(metadata_json ->> 'name'), '')
WHERE session_name IS NULL
  AND metadata_json ? 'name';

ALTER TABLE craft_agent_sessions
  ALTER COLUMN scope_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'craft_agent_sessions_scope_not_blank'
  ) THEN
    ALTER TABLE craft_agent_sessions
      ADD CONSTRAINT craft_agent_sessions_scope_not_blank
      CHECK (length(btrim(scope_id)) > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'craft_agent_sessions_name_not_blank'
  ) THEN
    ALTER TABLE craft_agent_sessions
      ADD CONSTRAINT craft_agent_sessions_name_not_blank
      CHECK (session_name IS NULL OR length(btrim(session_name)) > 0);
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS craft_agent_sessions_scope_session_idx
  ON craft_agent_sessions (scope_id, session_id);

CREATE INDEX IF NOT EXISTS craft_agent_sessions_scope_catalog_idx
  ON craft_agent_sessions (scope_id, catalog_order);

CREATE INDEX IF NOT EXISTS craft_agent_sessions_name_trgm_idx
  ON craft_agent_sessions USING gin (session_name gin_trgm_ops)
  WHERE session_name IS NOT NULL;

ALTER TABLE craft_agent_session_events
  ADD COLUMN IF NOT EXISTS scope_id text;

UPDATE craft_agent_session_events AS event
SET scope_id = session.scope_id
FROM craft_agent_sessions AS session
WHERE event.session_id = session.session_id
  AND event.scope_id IS NULL;

ALTER TABLE craft_agent_session_events
  ALTER COLUMN scope_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'craft_agent_session_events_scope_not_blank'
  ) THEN
    ALTER TABLE craft_agent_session_events
      ADD CONSTRAINT craft_agent_session_events_scope_not_blank
      CHECK (length(btrim(scope_id)) > 0);
  END IF;

  ALTER TABLE craft_agent_session_events
    DROP CONSTRAINT IF EXISTS craft_agent_session_events_session_id_fkey;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'craft_agent_session_events_scope_session_fkey'
  ) THEN
    ALTER TABLE craft_agent_session_events
      ADD CONSTRAINT craft_agent_session_events_scope_session_fkey
      FOREIGN KEY (scope_id, session_id)
      REFERENCES craft_agent_sessions (scope_id, session_id);
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS craft_agent_session_events_scope_sequence_idx
  ON craft_agent_session_events (scope_id, session_id, sequence);
