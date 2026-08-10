PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS bot_part_attempts (
  id TEXT PRIMARY KEY NOT NULL,
  upload_session_id TEXT NOT NULL REFERENCES upload_sessions(id) ON DELETE CASCADE,
  part_no INTEGER NOT NULL CHECK (part_no >= 0),
  idempotency_key TEXT NOT NULL,
  expected_size INTEGER NOT NULL CHECK (expected_size > 0),
  expected_sha256 TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('reserved', 'sending', 'sent', 'ambiguous', 'committed', 'abandoned')),
  telegram_message_id TEXT,
  telegram_file_id TEXT,
  reserved_at TEXT NOT NULL,
  sending_at TEXT,
  sent_at TEXT,
  ambiguous_at TEXT,
  committed_at TEXT,
  abandoned_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(upload_session_id, part_no),
  UNIQUE(upload_session_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS bot_part_attempts_session_state
  ON bot_part_attempts(upload_session_id, state, updated_at);
