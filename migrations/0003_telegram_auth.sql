ALTER TABLE users ADD COLUMN telegram_id TEXT;
ALTER TABLE users ADD COLUMN phone TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS users_telegram_id ON users(telegram_id) WHERE telegram_id IS NOT NULL;
