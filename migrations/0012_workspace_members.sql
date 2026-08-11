CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id TEXT PRIMARY KEY NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS workspace_members_user ON workspace_members(user_id);
CREATE INDEX IF NOT EXISTS workspace_members_created ON workspace_members(created_at);
