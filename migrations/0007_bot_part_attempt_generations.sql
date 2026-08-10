PRAGMA foreign_keys = ON;

ALTER TABLE bot_part_attempts ADD COLUMN send_generation TEXT;

CREATE INDEX IF NOT EXISTS bot_part_attempts_state_generation
  ON bot_part_attempts(state, send_generation, sending_lease_until);
