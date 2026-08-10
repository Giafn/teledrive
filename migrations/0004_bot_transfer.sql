PRAGMA foreign_keys = ON;

ALTER TABLE objects ADD COLUMN storage_backend TEXT NOT NULL DEFAULT 'legacy'
  CHECK (storage_backend IN ('legacy', 'bot_api'));
ALTER TABLE objects ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private'
  CHECK (visibility IN ('private', 'shared'));

ALTER TABLE upload_sessions ADD COLUMN bot_account_id TEXT REFERENCES telegram_bot_accounts(id) ON DELETE RESTRICT;
ALTER TABLE upload_sessions ADD COLUMN telegram_channel_id TEXT;

CREATE INDEX IF NOT EXISTS objects_bot_visibility_listing
  ON objects(storage_backend, visibility, status, deleted_at, updated_at DESC, id);
CREATE INDEX IF NOT EXISTS upload_sessions_bot_account
  ON upload_sessions(bot_account_id, telegram_channel_id, status);
