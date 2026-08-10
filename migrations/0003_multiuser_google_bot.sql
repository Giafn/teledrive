PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS auth_identities (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('google')),
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  UNIQUE(provider, issuer, subject)
);
CREATE INDEX IF NOT EXISTS auth_identities_user ON auth_identities(user_id);

CREATE TABLE IF NOT EXISTS oauth_transactions (
  id TEXT PRIMARY KEY NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('google')),
  state_hash TEXT NOT NULL UNIQUE,
  nonce_hash TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('login', 'link')),
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  issued_session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS oauth_transactions_expiry ON oauth_transactions(expires_at, used_at);

CREATE TABLE IF NOT EXISTS auth_rate_limits (
  key TEXT PRIMARY KEY NOT NULL,
  window_started_at INTEGER NOT NULL,
  attempt_count INTEGER NOT NULL CHECK (attempt_count >= 0)
);

CREATE TABLE IF NOT EXISTS telegram_bot_accounts (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bot_id TEXT NOT NULL,
  bot_username TEXT NOT NULL,
  token_ciphertext TEXT NOT NULL,
  token_key_version INTEGER NOT NULL,
  webhook_secret_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS telegram_bot_accounts_active_user
  ON telegram_bot_accounts(user_id) WHERE status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS telegram_bot_accounts_active_bot
  ON telegram_bot_accounts(bot_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS telegram_bot_accounts_webhook_secret
  ON telegram_bot_accounts(webhook_secret_hash, status);

CREATE TABLE IF NOT EXISTS telegram_onboarding_challenges (
  id TEXT PRIMARY KEY NOT NULL,
  bot_account_id TEXT NOT NULL REFERENCES telegram_bot_accounts(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'bound', 'expired')),
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  channel_id TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS telegram_onboarding_one_pending_bot
  ON telegram_onboarding_challenges(bot_account_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS telegram_onboarding_expiry
  ON telegram_onboarding_challenges(status, expires_at);

CREATE TABLE IF NOT EXISTS telegram_channel_bindings (
  id TEXT PRIMARY KEY NOT NULL,
  bot_account_id TEXT NOT NULL REFERENCES telegram_bot_accounts(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  verified_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS telegram_channel_bindings_bot
  ON telegram_channel_bindings(bot_account_id);
CREATE UNIQUE INDEX IF NOT EXISTS telegram_channel_bindings_active_channel
  ON telegram_channel_bindings(channel_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS telegram_channel_bindings_user
  ON telegram_channel_bindings(user_id, status);

CREATE TABLE IF NOT EXISTS telegram_webhook_replays (
  bot_account_id TEXT NOT NULL REFERENCES telegram_bot_accounts(id) ON DELETE CASCADE,
  update_id INTEGER NOT NULL,
  received_at TEXT NOT NULL,
  PRIMARY KEY (bot_account_id, update_id)
);
CREATE INDEX IF NOT EXISTS telegram_webhook_replays_received
  ON telegram_webhook_replays(received_at);
