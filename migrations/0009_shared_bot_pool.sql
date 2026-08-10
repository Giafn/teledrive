PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS telegram_pool (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  channel_id TEXT NOT NULL,
  bot_count INTEGER NOT NULL,
  verified_at TEXT NOT NULL
);

ALTER TABLE object_parts ADD COLUMN bot_index INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bot_part_attempts ADD COLUMN bot_index INTEGER NOT NULL DEFAULT 0;

DROP INDEX IF EXISTS upload_sessions_bot_account;
ALTER TABLE upload_sessions DROP COLUMN bot_account_id;
ALTER TABLE upload_sessions DROP COLUMN telegram_channel_id;

DROP TABLE IF EXISTS telegram_webhook_replays;
DROP TABLE IF EXISTS telegram_channel_bindings;
DROP TABLE IF EXISTS telegram_onboarding_challenges;
DROP TABLE IF EXISTS telegram_bot_accounts;
DROP TABLE IF EXISTS linking_codes;

ALTER TABLE workspaces DROP COLUMN telegram_channel_id;
