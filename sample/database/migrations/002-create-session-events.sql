CREATE TABLE IF NOT EXISTS craft_agent_session_events (
  scope_id VARCHAR(191) NOT NULL,
  session_id VARCHAR(191) NOT NULL,
  sequence BIGINT UNSIGNED NOT NULL,
  event_id VARCHAR(191) NOT NULL,
  event_type VARCHAR(64) NOT NULL,
  run_id VARCHAR(191) NULL,
  turn_id VARCHAR(191) NULL,
  payload_json JSON NOT NULL,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (scope_id, session_id, sequence),
  UNIQUE KEY craft_agent_session_events_event_id_unique (event_id),
  KEY craft_agent_session_events_run_idx (run_id),
  KEY craft_agent_session_events_turn_idx (scope_id, session_id, turn_id, sequence),
  CONSTRAINT craft_agent_session_events_scope_session_fkey
    FOREIGN KEY (scope_id, session_id)
    REFERENCES craft_agent_sessions (scope_id, session_id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
