PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY NOT NULL,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS passkeys (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key BLOB NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0 CHECK (counter >= 0),
  transports TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS passkeys_user_credential ON passkeys(user_id, id);
CREATE INDEX IF NOT EXISTS passkeys_user ON passkeys(user_id);

CREATE TABLE IF NOT EXISTS webauthn_challenges (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('registration', 'authentication')),
  challenge TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS webauthn_challenges_expiry ON webauthn_challenges(expires_at, used_at);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  csrf_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_expiry ON sessions(user_id, expires_at);

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  telegram_channel_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS workspaces_owner ON workspaces(owner_id);

CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES folders(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  path_key TEXT NOT NULL,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS folders_active_name
  ON folders(workspace_id, COALESCE(parent_id, ''), normalized_name)
  WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS folders_active_root_name
  ON folders(workspace_id, normalized_name)
  WHERE parent_id IS NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS folders_children
  ON folders(workspace_id, parent_id, deleted_at, name, id);

CREATE TABLE IF NOT EXISTS objects (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size >= 0),
  sha256 TEXT,
  part_count INTEGER NOT NULL CHECK (part_count >= 0),
  status TEXT NOT NULL CHECK (status IN ('uploading', 'completed', 'aborted', 'deleted')),
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS objects_folder_listing
  ON objects(workspace_id, folder_id, status, deleted_at, created_at DESC, id);
CREATE INDEX IF NOT EXISTS objects_name_search
  ON objects(workspace_id, normalized_name);

CREATE TABLE IF NOT EXISTS object_parts (
  id TEXT PRIMARY KEY NOT NULL,
  object_id TEXT NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
  part_no INTEGER NOT NULL CHECK (part_no >= 0),
  size INTEGER NOT NULL CHECK (size >= 0),
  sha256 TEXT NOT NULL,
  message_id TEXT NOT NULL,
  bot_file_id TEXT,
  idempotency_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(object_id, part_no),
  UNIQUE(object_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS object_parts_order ON object_parts(object_id, part_no);

CREATE TABLE IF NOT EXISTS upload_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  object_id TEXT NOT NULL UNIQUE REFERENCES objects(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('created', 'uploading', 'paused', 'verifying', 'completed', 'failed', 'aborted')),
  chunk_size INTEGER NOT NULL,
  expected_part_count INTEGER NOT NULL CHECK (expected_part_count >= 0),
  idempotency_key TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS upload_sessions_user_status ON upload_sessions(user_id, status, expires_at);

CREATE TABLE IF NOT EXISTS linking_codes (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'linked', 'expired')),
  expires_at TEXT NOT NULL,
  used_at TEXT,
  telegram_user_id TEXT,
  telegram_chat_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS linking_codes_pending ON linking_codes(status, expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS linking_codes_one_pending_user
  ON linking_codes(user_id)
  WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY NOT NULL,
  actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_events_actor_time ON audit_events(actor_id, created_at DESC);
