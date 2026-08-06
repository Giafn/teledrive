ALTER TABLE webauthn_challenges ADD COLUMN mode TEXT NOT NULL DEFAULT 'authentication';
ALTER TABLE webauthn_challenges ADD COLUMN issued_session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS webauthn_challenges_mode_expiry
  ON webauthn_challenges(mode, expires_at, used_at);
CREATE UNIQUE INDEX IF NOT EXISTS webauthn_bootstrap_pending
  ON webauthn_challenges(mode)
  WHERE mode = 'bootstrap_registration' AND used_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS linking_codes_one_pending_user
  ON linking_codes(user_id)
  WHERE status = 'pending';

-- Protect databases created from pre-fix 0001, whose self-FK used CASCADE.
CREATE TRIGGER IF NOT EXISTS folders_restrict_parent_delete
BEFORE DELETE ON folders
WHEN EXISTS (SELECT 1 FROM folders child WHERE child.parent_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'folder has child rows');
END;
