import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('Google OAuth transaction migration', () => {
  it('rebuilds oauth_transactions inside an existing transaction', async () => {
    const sql = await readFile(
      new URL('../../../migrations/0010_google_oauth_register_mode.sql', import.meta.url),
      'utf8',
    );
    const db = new DatabaseSync(':memory:');

    expect(sql).toContain('PRAGMA defer_foreign_keys = ON;');
    expect(sql).not.toMatch(/(?:BEGIN|COMMIT|foreign_keys\s*=\s*OFF)/u);
    expect(sql).toContain("CHECK (mode IN ('login', 'link', 'register'))");

    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE users (id TEXT PRIMARY KEY);
      CREATE TABLE sessions (id TEXT PRIMARY KEY);
      CREATE TABLE oauth_transactions (
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
      CREATE INDEX oauth_transactions_expiry ON oauth_transactions(expires_at, used_at);
      INSERT INTO users VALUES ('user-1');
      INSERT INTO oauth_transactions VALUES
        ('tx-login', 'google', 'state-1', 'nonce-1', 'verifier-1', 'login', 'user-1', NULL, '2099-01-01', NULL, '2026-01-01'),
        ('tx-link', 'google', 'state-2', 'nonce-2', 'verifier-2', 'link', 'user-1', NULL, '2099-01-02', '2026-01-02', '2026-01-01');
    `);

    db.exec('BEGIN TRANSACTION');
    db.exec(sql);
    db.exec('COMMIT');

    const rows = db.prepare('SELECT id, mode, used_at FROM oauth_transactions ORDER BY id').all();
    expect(rows).toEqual([
      { id: 'tx-link', mode: 'link', used_at: '2026-01-02' },
      { id: 'tx-login', mode: 'login', used_at: null },
    ]);
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'oauth_transactions'")
      .all();
    expect(indexes).toContainEqual({ name: 'oauth_transactions_expiry' });

    db.prepare(
      "INSERT INTO oauth_transactions (id, provider, state_hash, nonce_hash, code_verifier, mode, expires_at, created_at) VALUES (?, 'google', ?, ?, ?, 'register', ?, ?)",
    ).run('tx-register', 'state-3', 'nonce-3', 'verifier-3', '2099-01-03', '2026-01-03');
    expect(db.prepare('SELECT mode FROM oauth_transactions WHERE id = ?').get('tx-register')).toEqual({
      mode: 'register',
    });
    db.close();
  });

  it('extends identity and OAuth providers without dropping existing Google rows', async () => {
    const sql = await readFile(
      new URL('../../../migrations/0011_telegram_oidc_provider.sql', import.meta.url),
      'utf8',
    );
    const db = new DatabaseSync(':memory:');

    expect(sql).toContain("CHECK (provider IN ('google', 'telegram'))");
    expect(sql).not.toMatch(/(?:BEGIN|COMMIT|foreign_keys\s*=\s*OFF)/u);
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE users (id TEXT PRIMARY KEY);
      CREATE TABLE sessions (id TEXT PRIMARY KEY);
      CREATE TABLE auth_identities (
        id TEXT PRIMARY KEY NOT NULL,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        provider TEXT NOT NULL CHECK (provider IN ('google')),
        issuer TEXT NOT NULL,
        subject TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_used_at TEXT,
        UNIQUE(provider, issuer, subject)
      );
      CREATE INDEX auth_identities_user ON auth_identities(user_id);
      CREATE TABLE oauth_transactions (
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
      CREATE INDEX oauth_transactions_expiry ON oauth_transactions(expires_at, used_at);
      INSERT INTO users VALUES ('user-1');
      INSERT INTO auth_identities VALUES
        ('identity-google', 'user-1', 'google', 'https://accounts.google.com', 'google-sub', '2026-01-01', NULL);
      INSERT INTO oauth_transactions VALUES
        ('tx-google', 'google', 'state-1', 'nonce-1', 'verifier-1', 'login', 'user-1', NULL, '2099-01-01', NULL, '2026-01-01');
    `);

    db.exec('BEGIN TRANSACTION');
    db.exec(sql);
    db.exec('COMMIT');

    db.prepare(
      "INSERT INTO auth_identities VALUES (?, ?, 'telegram', ?, ?, ?, NULL)",
    ).run('identity-telegram', 'user-1', 'https://oauth.telegram.org', 'telegram-sub', '2026-01-02');
    db.prepare(
      "INSERT INTO oauth_transactions VALUES (?, 'telegram', ?, ?, ?, 'register', NULL, NULL, ?, NULL, ?)",
    ).run('tx-telegram', 'state-2', 'nonce-2', 'verifier-2', '2099-01-02', '2026-01-02');

    expect(db.prepare('SELECT provider FROM auth_identities ORDER BY id').all()).toEqual([
      { provider: 'google' },
      { provider: 'telegram' },
    ]);
    expect(db.prepare('SELECT provider FROM oauth_transactions ORDER BY id').all()).toEqual([
      { provider: 'google' },
      { provider: 'telegram' },
    ]);
    db.close();
  });
});
