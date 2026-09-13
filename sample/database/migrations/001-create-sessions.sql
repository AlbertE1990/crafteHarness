CREATE TABLE IF NOT EXISTS craft_agent_sessions (
  scope_id VARCHAR(191) NOT NULL,
  session_id VARCHAR(191) NOT NULL,
  session_name VARCHAR(255) NULL,
  catalog_order BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  version BIGINT UNSIGNED NOT NULL DEFAULT 0,
  metadata_json JSON NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (scope_id, session_id),
  UNIQUE KEY craft_agent_sessions_catalog_order_unique (catalog_order),
  KEY craft_agent_sessions_scope_catalog_idx (scope_id, catalog_order),
  KEY craft_agent_sessions_scope_name_idx (scope_id, session_name)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
