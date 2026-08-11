PRAGMA defer_foreign_keys = ON;

CREATE TABLE oauth_transactions_new (
  id TEXT PRIMARY KEY NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('google')),
  state_hash TEXT NOT NULL UNIQUE,
  nonce_hash TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('login', 'link', 'register')),
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  issued_session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);

INSERT INTO oauth_transactions_new (
  id,
  provider,
  state_hash,
  nonce_hash,
  code_verifier,
  mode,
  user_id,
  issued_session_id,
  expires_at,
  used_at,
  created_at
)
SELECT
  id,
  provider,
  state_hash,
  nonce_hash,
  code_verifier,
  mode,
  user_id,
  issued_session_id,
  expires_at,
  used_at,
  created_at
FROM oauth_transactions;

DROP TABLE oauth_transactions;
ALTER TABLE oauth_transactions_new RENAME TO oauth_transactions;

CREATE INDEX IF NOT EXISTS oauth_transactions_expiry ON oauth_transactions(expires_at, used_at);
