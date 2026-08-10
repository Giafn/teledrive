PRAGMA foreign_keys = ON;

ALTER TABLE bot_part_attempts ADD COLUMN sending_lease_until TEXT;

CREATE INDEX IF NOT EXISTS bot_part_attempts_sending_lease
  ON bot_part_attempts(state, sending_lease_until);
