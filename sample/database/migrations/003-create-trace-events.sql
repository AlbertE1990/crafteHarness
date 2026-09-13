CREATE TABLE IF NOT EXISTS craft_agent_trace_events (
  scope_id VARCHAR(191) NOT NULL,
  session_id VARCHAR(191) NOT NULL,
  trace_sequence BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  run_id VARCHAR(191) NOT NULL,
  turn_id VARCHAR(191) NOT NULL,
  event_type VARCHAR(64) NOT NULL,
  payload_json JSON NOT NULL,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (scope_id, session_id, trace_sequence),
  UNIQUE KEY craft_agent_trace_events_sequence_unique (trace_sequence),
  KEY craft_agent_trace_events_session_sequence_idx (scope_id, session_id, trace_sequence),
  KEY craft_agent_trace_events_run_idx (scope_id, session_id, run_id, trace_sequence),
  CONSTRAINT craft_agent_trace_events_scope_session_fkey
    FOREIGN KEY (scope_id, session_id)
    REFERENCES craft_agent_sessions (scope_id, session_id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
