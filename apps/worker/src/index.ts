import { Hono, type Context } from 'hono';
import { validateManifest } from './manifest';
import {
  base64url,
  constantTimeEqual,
  cookieValue,
  isExactOrigin,
  randomToken,
  redactJson,
  secretHash,
  serializeCookie,
} from './security';
import type {
  AppEnv,
  Bindings,
  D1Database,
  D1PreparedStatement,
  PartRow,
  SessionRow,
  UploadRow,
  UserRow,
} from './types';
import { canAbort, canCommitPart, canComplete, uploadIsOpen } from './upload-state';
import {
  canEditObject,
  decodeMetadataCursor,
  encodeMetadataCursor,
  retentionUntil,
  TRASH_RETENTION_DAYS,
} from './metadata';

const app = new Hono<AppEnv>();
const SESSION_COOKIE = '__Host-td_session';
const CSRF_COOKIE = 'td_csrf';
const MAX_JSON_BYTES = 256 * 1024;
const MAX_NAME_LENGTH = 255;
const MIN_CHUNK_SIZE = 8 * 1024 * 1024;
const MAX_CHUNK_SIZE = 19 * 1024 * 1024;
const MAX_PARTS = 100_000;
const SHA256 = /^[a-f0-9]{64}$/u;
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const authRate = new Map<string, { startedAt: number; count: number }>();

class HttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 422 | 429 | 500,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function now(): string {
  return new Date().toISOString();
}

function fail(status: HttpError['status'], code: string, message: string): never {
  throw new HttpError(status, code, message);
}

function requireConfig(env: Bindings, ...keys: (keyof Bindings)[]): void {
  for (const key of keys) if (!env[key]) fail(500, 'CONFIGURATION_ERROR', 'Worker configuration is incomplete');
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(422, 'INVALID_JSON', 'JSON object required');
  return value as Record<string, unknown>;
}

function metadataOnly(body: Record<string, unknown>): Record<string, unknown> {
  if (Object.keys(body).some((key) => /^(?:blob|bytes|content|file|payload)$/iu.test(key))) {
    fail(413, 'BLOB_NOT_ACCEPTED', 'Worker accepts metadata only; file bytes must bypass Worker');
  }
  return body;
}

function stringValue(value: unknown, field: string, max = 1024): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max)
    fail(422, 'INVALID_FIELD', `${field} is invalid`);
  return value;
}

function optionalString(value: unknown, field: string, max = 1024): string | undefined {
  if (value === undefined || value === null) return undefined;
  return stringValue(value, field, max);
}

function integerValue(value: unknown, field: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    fail(422, 'INVALID_FIELD', `${field} is invalid`);
  }
  return value;
}

function normalizedName(value: unknown, field = 'name'): { name: string; normalized: string } {
  const name = stringValue(value, field, MAX_NAME_LENGTH).trim().normalize('NFKC');
  if (!name || name === '.' || name === '..') fail(422, 'INVALID_NAME', `${field} is invalid`);
  return { name, normalized: name.toLocaleLowerCase('en-US') };
}

function hashValue(value: unknown, field: string): string {
  const hash = stringValue(value, field, 64).toLowerCase();
  if (!SHA256.test(hash)) fail(422, 'INVALID_HASH', `${field} must be SHA-256`);
  return hash;
}

function isConstraintError(error: unknown): boolean {
  return error instanceof Error && /constraint|unique|foreign key/iu.test(error.message);
}

function applySecurityHeaders(c: Context<AppEnv>): void {
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('X-Frame-Options', 'DENY');
  c.header('Cross-Origin-Resource-Policy', 'same-site');
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  c.header('Cache-Control', 'no-store');
}

async function first<T>(db: D1Database, sql: string, ...values: unknown[]): Promise<T | null> {
  return db
    .prepare(sql)
    .bind(...values)
    .first<T>();
}

async function all<T>(db: D1Database, sql: string, ...values: unknown[]): Promise<T[]> {
  const result = await db
    .prepare(sql)
    .bind(...values)
    .all<T>();
  return result.results;
}

function audit(db: D1Database, actorId: string, action: string, targetType: string, targetId: string | null) {
  return db
    .prepare(
      'INSERT INTO audit_events (id, actor_id, action, target_type, target_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .bind(randomToken(18), actorId, action, targetType, targetId, now());
}

async function readJson<T>(c: Context<AppEnv>): Promise<T> {
  const parsed = c.get('jsonBody');
  if (parsed === undefined) fail(422, 'INVALID_JSON', 'Valid JSON body required');
  return parsed as T;
}

function requestCookie(c: Context<AppEnv>, name: string): string | undefined {
  return cookieValue(c.req.header('Cookie'), name);
}

async function getSession(c: Context<AppEnv>): Promise<SessionRow | undefined> {
  const token = requestCookie(c, SESSION_COOKIE);
  if (!token) return undefined;
  requireConfig(c.env, 'APP_SESSION_SECRET');
  const tokenHash = await secretHash(token, c.env.APP_SESSION_SECRET);
  const row = await first<SessionRow>(
    c.env.DB,
    `
    SELECT s.id AS session_id, s.csrf_hash, s.expires_at,
           u.id, u.username, u.display_name, u.status
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ? AND u.status = 'active'
  `,
    tokenHash,
    now(),
  );
  if (row) c.set('session', row);
  return row ?? undefined;
}

async function requireSession(c: Context<AppEnv>): Promise<SessionRow> {
  const session = c.get('session') ?? (await getSession(c));
  if (!session) fail(401, 'AUTH_REQUIRED', 'Authentication required');
  return session;
}

async function setSession(c: Context<AppEnv>, userId: string): Promise<string> {
  requireConfig(c.env, 'APP_SESSION_SECRET');
  const rawSession = randomToken(32);
  const csrf = randomToken(32);
  const timestamp = now();
  const ttl = Math.min(Math.max(Number(c.env.SESSION_TTL_SECONDS ?? 60 * 60 * 24 * 14), 900), 60 * 60 * 24 * 30);
  const expires = new Date(Date.now() + ttl * 1000).toISOString();
  await c.env.DB.prepare(
    `
    INSERT INTO sessions (id, user_id, token_hash, csrf_hash, expires_at, created_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `,
  )
    .bind(
      randomToken(18),
      userId,
      await secretHash(rawSession, c.env.APP_SESSION_SECRET),
      await secretHash(csrf, c.env.APP_SESSION_SECRET),
      expires,
      timestamp,
      timestamp,
    )
    .run();
  c.header(
    'Set-Cookie',
    serializeCookie(SESSION_COOKIE, rawSession, { httpOnly: true, maxAge: ttl, sameSite: 'Lax' }),
    { append: true },
  );
  c.header('Set-Cookie', serializeCookie(CSRF_COOKIE, csrf, { maxAge: ttl, sameSite: 'Lax' }), { append: true });
  return csrf;
}

async function validateMutationCsrf(c: Context<AppEnv>): Promise<void> {
  const session = await getSession(c);
  if (session) {
    const csrf = c.req.header('X-CSRF-Token');
    if (!csrf || csrf.length > 256) fail(403, 'CSRF_REQUIRED', 'CSRF token required');
    const expected = await secretHash(csrf, c.env.APP_SESSION_SECRET);
    if (!constantTimeEqual(expected, session.csrf_hash)) fail(403, 'CSRF_INVALID', 'CSRF token invalid');
    return;
  }

  if (c.req.path === '/v1/auth/telegram') {
    return;
  }

  const csrf = c.req.header('X-CSRF-Token');
  if (!csrf || csrf.length > 256) fail(403, 'CSRF_REQUIRED', 'CSRF token required');
  fail(403, 'CSRF_REQUIRED', 'CSRF token required');
}

function cursorEncode(createdAt: string, id: string): string {
  return base64url(new TextEncoder().encode(JSON.stringify({ createdAt, id })));
}

function cursorDecode(value: string | undefined): { createdAt: string; id: string } | undefined {
  if (!value) return undefined;
  try {
    const normalized = value
      .replaceAll('-', '+')
      .replaceAll('_', '/')
      .padEnd(Math.ceil(value.length / 4) * 4, '=');
    const bytes = Uint8Array.from(atob(normalized), (character) => character.charCodeAt(0));
    const decoded = record(JSON.parse(new TextDecoder().decode(bytes)));
    const createdAt = stringValue(decoded.createdAt, 'cursor', 64);
    const id = stringValue(decoded.id, 'cursor', 128);
    return { createdAt, id };
  } catch {
    fail(422, 'INVALID_CURSOR', 'Cursor is invalid');
  }
}

function metadataCursor(c: Context<AppEnv>) {
  const value = c.req.query('cursor');
  const cursor = decodeMetadataCursor(value);
  if (value && !cursor) fail(422, 'INVALID_CURSOR', 'Cursor is invalid');
  return cursor;
}

function changes(result: { meta?: { changes?: number } }): number {
  return result.meta?.changes ?? 0;
}

function rateLimitAuth(c: Context<AppEnv>): void {
  const key = c.req.header('CF-Connecting-IP') ?? 'unknown';
  const timestamp = Date.now();
  const previous = authRate.get(key);
  if (!previous || timestamp - previous.startedAt >= 60_000) {
    authRate.set(key, { startedAt: timestamp, count: 1 });
  } else {
    previous.count += 1;
    if (previous.count > 12) fail(429, 'AUTH_RATE_LIMITED', 'Too many authentication attempts');
  }
  if (authRate.size > 2048) {
    for (const [entry, value] of authRate) {
      if (timestamp - value.startedAt >= 60_000) authRate.delete(entry);
    }
  }
}

function verifyTelegramWebhookSecret(c: Context<AppEnv>): void {
  requireConfig(c.env, 'TELEGRAM_WEBHOOK_SECRET');
  const secret = c.req.header('X-Telegram-Bot-Api-Secret-Token');
  if (!secret || !constantTimeEqual(secret, c.env.TELEGRAM_WEBHOOK_SECRET))
    fail(403, 'WEBHOOK_REJECTED', 'Webhook rejected');
}

async function workspaceForUser(c: Context<AppEnv>, userId: string) {
  const workspace = await first<{ id: string; name: string }>(
    c.env.DB,
    'SELECT id, name FROM workspaces WHERE owner_id = ?',
    userId,
  );
  if (!workspace) fail(500, 'WORKSPACE_MISSING', 'Workspace is missing');
  return workspace;
}

async function folderForUser(c: Context<AppEnv>, userId: string, folderId: string | undefined, includeDeleted = false) {
  const workspace = await workspaceForUser(c, userId);
  const folder = folderId
    ? await first<{
        id: string;
        parent_id: string | null;
        name: string;
        normalized_name: string;
        deleted_at: string | null;
      }>(
        c.env.DB,
        `
        SELECT f.id, f.parent_id, f.name, f.normalized_name, f.deleted_at
        FROM folders f JOIN workspaces w ON w.id = f.workspace_id
        WHERE f.id = ? AND w.owner_id = ? ${includeDeleted ? '' : 'AND f.deleted_at IS NULL'}
      `,
        folderId,
        userId,
      )
    : await first<{
        id: string;
        parent_id: string | null;
        name: string;
        normalized_name: string;
        deleted_at: string | null;
      }>(
        c.env.DB,
        `
        SELECT f.id, f.parent_id, f.name, f.normalized_name, f.deleted_at
        FROM folders f WHERE f.workspace_id = ? AND f.parent_id IS NULL
        ${includeDeleted ? '' : 'AND f.deleted_at IS NULL'}
      `,
        workspace.id,
      );
  if (!folder) fail(404, 'FOLDER_NOT_FOUND', 'Folder not found');
  return { workspace, folder };
}

async function uploadForUser(c: Context<AppEnv>, userId: string, uploadId: string): Promise<UploadRow> {
  const upload = await first<UploadRow>(
    c.env.DB,
    `
    SELECT us.id, us.user_id, us.object_id, us.status, us.chunk_size, us.expected_part_count,
           us.idempotency_key, us.expires_at, o.name AS object_name, o.mime,
           o.size AS object_size, o.sha256 AS object_sha256, o.status AS object_status, o.deleted_at AS object_deleted_at, o.folder_id
    FROM upload_sessions us JOIN objects o ON o.id = us.object_id
    WHERE us.id = ? AND us.user_id = ?
  `,
    uploadId,
    userId,
  );
  if (!upload) fail(404, 'UPLOAD_NOT_FOUND', 'Upload session not found');
  return upload;
}

async function objectForUser(c: Context<AppEnv>, userId: string, objectId: string, includeDeleted = true) {
  const object = await first<{
    id: string;
    workspace_id: string;
    folder_id: string;
    name: string;
    mime: string;
    size: number;
    sha256: string | null;
    part_count: number;
    status: string;
    deleted_at: string | null;
    created_at: string;
    updated_at: string;
  }>(
    c.env.DB,
    `
    SELECT o.id, o.workspace_id, o.folder_id, o.name, o.mime, o.size, o.sha256, o.part_count,
           o.status, o.deleted_at, o.created_at, o.updated_at
    FROM objects o JOIN workspaces w ON w.id = o.workspace_id
    WHERE o.id = ? AND w.owner_id = ? ${includeDeleted ? '' : 'AND o.deleted_at IS NULL'}
  `,
    objectId,
    userId,
  );
  if (!object) fail(404, 'OBJECT_NOT_FOUND', 'Object not found');
  return object;
}

// Request IDs and security headers are attached to every response, including errors.
app.use('*', async (c, next) => {
  const incoming = c.req.header('X-Request-ID');
  const requestId = incoming && /^[A-Za-z0-9._:-]{1,128}$/u.test(incoming) ? incoming : randomToken(12);
  c.set('requestId', requestId);
  c.header('X-Request-ID', requestId);
  await next();
});

app.use('*', async (c, next) => {
  const origin = c.req.header('Origin');
  if (origin && !isExactOrigin(origin, c.env.APP_ORIGIN)) fail(403, 'ORIGIN_REJECTED', 'Origin is not allowed');
  if (c.req.method === 'OPTIONS') {
    if (!isExactOrigin(origin, c.env.APP_ORIGIN)) fail(403, 'ORIGIN_REJECTED', 'Origin is not allowed');
    c.header('Access-Control-Allow-Origin', c.env.APP_ORIGIN);
    c.header('Access-Control-Allow-Credentials', 'true');
    c.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    c.header('Access-Control-Allow-Headers', 'Content-Type, X-CSRF-Token, X-Bootstrap-Token, X-Request-ID');
    c.header('Access-Control-Max-Age', '600');
    c.header('Vary', 'Origin');
    applySecurityHeaders(c);
    return c.body(null, 204);
  }
  await next();
  applySecurityHeaders(c);
  if (origin === c.env.APP_ORIGIN) {
    c.header('Access-Control-Allow-Origin', c.env.APP_ORIGIN);
    c.header('Access-Control-Allow-Credentials', 'true');
    c.header('Vary', 'Origin');
  }
});

app.use('*', async (c, next) => {
  if (MUTATING_METHODS.has(c.req.method) && c.req.path !== '/v1/webhooks/telegram') {
    if (!isExactOrigin(c.req.header('Origin'), c.env.APP_ORIGIN))
      fail(403, 'ORIGIN_REQUIRED', 'Exact application origin required');
    await validateMutationCsrf(c);
  }
  await next();
});

app.use('*', async (c, next) => {
  if (MUTATING_METHODS.has(c.req.method) && c.req.method !== 'DELETE') {
    if (c.req.path === '/v1/webhooks/telegram') verifyTelegramWebhookSecret(c);
    const contentType = c.req.header('Content-Type')?.split(';', 1)[0].trim().toLowerCase();
    if (contentType !== 'application/json') fail(415, 'JSON_REQUIRED', 'application/json required');
    const length = Number(c.req.header('Content-Length') ?? 0);
    if (length > MAX_JSON_BYTES) fail(413, 'JSON_TOO_LARGE', 'Metadata JSON body is too large');
    const bytes = await c.req.raw.arrayBuffer();
    if (bytes.byteLength > MAX_JSON_BYTES) fail(413, 'JSON_TOO_LARGE', 'Metadata JSON body is too large');
    try {
      const text = new TextDecoder().decode(bytes).trim();
      c.set('jsonBody', text ? JSON.parse(text) : {});
    } catch {
      fail(422, 'INVALID_JSON', 'Valid JSON body required');
    }
  }
  await next();
});

app.get('/health', (c) => c.json({ ok: true, service: 'metadata-worker' }));

app.get('/v1/auth/csrf', async (c) => {
  const token = randomToken(32);
  const session = await getSession(c);
  const maxAge = session ? Math.max(0, Math.floor((Date.parse(session.expires_at) - Date.now()) / 1000)) : 900;
  c.header('Set-Cookie', serializeCookie(CSRF_COOKIE, token, { maxAge, sameSite: 'Lax' }));
  if (session) {
    await c.env.DB.prepare('UPDATE sessions SET csrf_hash = ?, last_seen_at = ? WHERE id = ?')
      .bind(await secretHash(token, c.env.APP_SESSION_SECRET), now(), session.session_id)
      .run();
    session.csrf_hash = await secretHash(token, c.env.APP_SESSION_SECRET);
  }
  return c.json({ csrfToken: token });
});

app.get('/v1/auth/session', async (c) => {
  const session = await requireSession(c);
  return c.json({ user: { id: session.id, username: session.username, displayName: session.display_name } });
});

app.post('/v1/auth/telegram', async (c) => {
  applySecurityHeaders(c);
  rateLimitAuth(c);
  const body = record(metadataOnly(await readJson<Record<string, unknown>>(c)));
  const telegramId =
    typeof body.telegramId === 'number' && Number.isSafeInteger(body.telegramId)
      ? String(body.telegramId)
      : stringValue(body.telegramId, 'telegramId', 64);
  const displayName = optionalString(body.displayName, 'displayName', 255) || `User ${telegramId}`;
  const username = optionalString(body.username, 'username', 255) || `tg_${telegramId}`;
  const phone = optionalString(body.phone, 'phone', 64);
  const created = now();

  let user = await first<UserRow>(
    c.env.DB,
    'SELECT id, username, display_name, status FROM users WHERE telegram_id = ? OR username = ?',
    telegramId,
    username,
  );

  if (!user) {
    const userId = randomToken(18);
    const workspaceId = randomToken(18);
    const rootId = randomToken(18);

    await c.env.DB.batch([
      c.env.DB.prepare(
        'INSERT INTO users (id, username, display_name, status, telegram_id, phone, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).bind(userId, username, displayName, 'active', telegramId, phone ?? null, created, created),
      c.env.DB.prepare(
        'INSERT INTO workspaces (id, owner_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      ).bind(workspaceId, userId, 'My Drive', created, created),
      c.env.DB.prepare(
        'INSERT INTO folders (id, workspace_id, parent_id, name, normalized_name, path_key, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?)',
      ).bind(rootId, workspaceId, 'My Drive', 'my drive', rootId, created, created),
      audit(c.env.DB, userId, 'telegram.registered', 'user', userId),
    ]);

    user = await first<UserRow>(c.env.DB, 'SELECT id, username, display_name, status FROM users WHERE id = ?', userId);
  } else {
    await c.env.DB.prepare('UPDATE users SET status = ?, updated_at = ? WHERE id = ?')
      .bind('active', created, user.id)
      .run();
  }

  if (!user) fail(500, 'USER_CREATION_FAILED', 'Failed to create or load user');

  const csrfToken = await setSession(c, user.id);

  return c.json({
    ok: true,
    csrfToken,
    user: { id: user.id, username: user.username, displayName: user.display_name },
  });
});

app.post('/v1/auth/logout', async (c) => {
  const session = await requireSession(c);
  await c.env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(session.session_id).run();
  c.header('Set-Cookie', serializeCookie(SESSION_COOKIE, '', { httpOnly: true, maxAge: 0, sameSite: 'Lax' }));
  c.header('Set-Cookie', serializeCookie(CSRF_COOKIE, '', { maxAge: 0, sameSite: 'Lax' }), { append: true });
  return c.json({ ok: true });
});

app.get('/v1/folders/:id/children', async (c) => {
  const session = await requireSession(c);
  const { folder } = await folderForUser(c, session.id, c.req.param('id'));
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 50) || 50, 1), 100);
  const cursor = cursorDecode(c.req.query('cursor'));
  const after = cursor ?? { createdAt: '9999-12-31T23:59:59.999Z', id: '' };
  const rows = await all<{
    kind: 'folder' | 'object';
    id: string;
    name: string;
    mime: string | null;
    size: number | null;
    status: string | null;
    created_at: string;
    sort_at: string;
  }>(
    c.env.DB,
    `
    SELECT * FROM (
      SELECT 'folder' AS kind, f.id, f.name, NULL AS mime, NULL AS size, NULL AS status,
             f.created_at, f.created_at AS sort_at
      FROM folders f WHERE f.workspace_id = (SELECT workspace_id FROM folders WHERE id = ?)
        AND f.parent_id = ? AND f.deleted_at IS NULL
      UNION ALL
      SELECT 'object' AS kind, o.id, o.name, o.mime, o.size, o.status,
             o.created_at, o.created_at AS sort_at
      FROM objects o WHERE o.workspace_id = (SELECT workspace_id FROM folders WHERE id = ?)
        AND o.folder_id = ? AND o.status = 'completed' AND o.deleted_at IS NULL
    ) entries
    WHERE sort_at < ? OR (sort_at = ? AND id > ?)
    ORDER BY sort_at DESC, id ASC LIMIT ?
  `,
    folder.id,
    folder.id,
    folder.id,
    folder.id,
    after.createdAt,
    after.createdAt,
    after.id,
    limit + 1,
  );
  const hasMore = rows.length > limit;
  const items = (hasMore ? rows.slice(0, limit) : rows).map((row) => ({
    kind: row.kind,
    id: row.id,
    name: row.name,
    mime: row.mime,
    size: row.size,
    status: row.status,
    createdAt: row.created_at,
  }));
  const last = rows[limit - 1];
  return c.json({
    folder: { id: folder.id, name: folder.name },
    items,
    nextCursor: hasMore && last ? cursorEncode(last.sort_at, last.id) : null,
  });
});

app.get('/v1/workspace', async (c) => {
  const session = await requireSession(c);
  const workspace = await workspaceForUser(c, session.id);
  const root = await first<{ id: string; name: string }>(
    c.env.DB,
    'SELECT id, name FROM folders WHERE workspace_id = ? AND parent_id IS NULL AND deleted_at IS NULL',
    workspace.id,
  );
  if (!root) fail(500, 'ROOT_FOLDER_MISSING', 'Root folder is missing');
  return c.json({ workspace, rootFolder: root });
});

app.get('/v1/objects/recent', async (c) => {
  const session = await requireSession(c);
  const cursor = metadataCursor(c);
  if (cursor && cursor.kind !== 'object') fail(422, 'INVALID_CURSOR', 'Cursor is invalid');
  const after = cursor ?? {
    sortAt: '9999-12-31T23:59:59.999Z',
    secondaryAt: '9999-12-31T23:59:59.999Z',
    kind: 'object',
    id: '',
  };
  const secondaryAt = after.secondaryAt ?? '9999-12-31T23:59:59.999Z';
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 50) || 50, 1), 100);
  const rows = await all<{
    id: string;
    folder_id: string;
    name: string;
    mime: string;
    size: number;
    sha256: string | null;
    part_count: number;
    created_at: string;
    updated_at: string;
  }>(
    c.env.DB,
    `
    SELECT o.id, o.folder_id, o.name, o.mime, o.size, o.sha256, o.part_count, o.created_at, o.updated_at
    FROM objects o JOIN workspaces w ON w.id = o.workspace_id
    WHERE w.owner_id = ? AND o.status = 'completed' AND o.deleted_at IS NULL
      AND (o.updated_at < ? OR (o.updated_at = ? AND (o.created_at < ? OR (o.created_at = ? AND o.id > ?))))
    ORDER BY o.updated_at DESC, o.created_at DESC, o.id ASC
    LIMIT ?
  `,
    session.id,
    after.sortAt,
    after.sortAt,
    secondaryAt,
    secondaryAt,
    after.id,
    limit + 1,
  );
  const hasMore = rows.length > limit;
  const items = (hasMore ? rows.slice(0, limit) : rows).map((row) => ({
    id: row.id,
    folderId: row.folder_id,
    name: row.name,
    mime: row.mime,
    size: row.size,
    sha256: row.sha256,
    partCount: row.part_count,
    status: 'completed',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
  const last = rows[limit - 1];
  return c.json({
    items,
    nextCursor:
      hasMore && last
        ? encodeMetadataCursor({ sortAt: last.updated_at, secondaryAt: last.created_at, kind: 'object', id: last.id })
        : null,
  });
});

app.get('/v1/trash', async (c) => {
  const session = await requireSession(c);
  const cursor = metadataCursor(c);
  const after = cursor ?? { sortAt: '9999-12-31T23:59:59.999Z', kind: '', id: '' };
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 50) || 50, 1), 100);
  const rows = await all<{
    kind: 'folder' | 'object';
    id: string;
    parent_id: string | null;
    folder_id: string | null;
    name: string;
    mime: string | null;
    size: number | null;
    sha256: string | null;
    part_count: number | null;
    deleted_at: string;
    created_at: string;
    updated_at: string;
    sort_at: string;
  }>(
    c.env.DB,
    `
    SELECT * FROM (
      SELECT 'folder' AS kind, f.id, f.parent_id, NULL AS folder_id, f.name, NULL AS mime, NULL AS size,
             NULL AS sha256, NULL AS part_count, f.deleted_at, f.created_at, f.updated_at, f.deleted_at AS sort_at
      FROM folders f JOIN workspaces w ON w.id = f.workspace_id
      WHERE w.owner_id = ? AND f.deleted_at IS NOT NULL
      UNION ALL
      SELECT 'object' AS kind, o.id, NULL AS parent_id, o.folder_id, o.name, o.mime, o.size,
             o.sha256, o.part_count, o.deleted_at, o.created_at, o.updated_at, o.deleted_at AS sort_at
      FROM objects o JOIN workspaces w ON w.id = o.workspace_id
      WHERE w.owner_id = ? AND o.status = 'deleted' AND o.deleted_at IS NOT NULL
    ) entries
    WHERE sort_at < ? OR (sort_at = ? AND (kind > ? OR (kind = ? AND id > ?)))
    ORDER BY sort_at DESC, kind ASC, id ASC
    LIMIT ?
  `,
    session.id,
    session.id,
    after.sortAt,
    after.sortAt,
    after.kind,
    after.kind,
    after.id,
    limit + 1,
  );
  const hasMore = rows.length > limit;
  const items = (hasMore ? rows.slice(0, limit) : rows).map((row) => {
    const retention = retentionUntil(row.deleted_at);
    return row.kind === 'folder'
      ? {
          type: 'folder' as const,
          id: row.id,
          parentId: row.parent_id,
          name: row.name,
          deletedAt: row.deleted_at,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          retentionUntil: retention,
        }
      : {
          type: 'object' as const,
          id: row.id,
          folderId: row.folder_id,
          name: row.name,
          mime: row.mime,
          size: row.size,
          sha256: row.sha256,
          partCount: row.part_count,
          deletedAt: row.deleted_at,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          retentionUntil: retention,
        };
  });
  const last = rows[limit - 1];
  return c.json({
    retentionDays: TRASH_RETENTION_DAYS,
    items,
    nextCursor: hasMore && last ? encodeMetadataCursor({ sortAt: last.sort_at, kind: last.kind, id: last.id }) : null,
  });
});

app.patch('/v1/objects/:id', async (c) => {
  const session = await requireSession(c);
  const body = metadataOnly(record(await readJson<unknown>(c)));
  const hasName = body.name !== undefined;
  const hasFolder = body.folderId !== undefined;
  if (!hasName && !hasFolder) fail(422, 'EMPTY_PATCH', 'Object name or folderId required');
  const object = await objectForUser(c, session.id, c.req.param('id'), false);
  const nextName = hasName ? normalizedName(body.name).name : object.name;
  const nextNormalized = normalizedName(nextName).normalized;
  const targetFolderId = hasFolder ? stringValue(body.folderId, 'folderId', 128) : object.folder_id;
  const target = await folderForUser(c, session.id, targetFolderId);
  if (
    !canEditObject(
      true,
      object.status,
      object.deleted_at,
      target.folder.deleted_at === null,
      target.workspace.id === object.workspace_id,
    )
  ) {
    fail(409, 'OBJECT_NOT_EDITABLE', 'Only completed objects in active folders can be edited');
  }
  const timestamp = now();
  const result = await c.env.DB.prepare(
    `UPDATE objects SET name = ?, normalized_name = ?, folder_id = ?, updated_at = ?
    WHERE id = ? AND workspace_id = ? AND status = 'completed' AND deleted_at IS NULL
      AND EXISTS (SELECT 1 FROM folders f WHERE f.id = ? AND f.workspace_id = objects.workspace_id AND f.deleted_at IS NULL)`,
  )
    .bind(nextName, nextNormalized, targetFolderId, timestamp, object.id, object.workspace_id, targetFolderId)
    .run();
  if (changes(result) !== 1) fail(409, 'OBJECT_STATE_CHANGED', 'Object state changed; retry');
  await audit(c.env.DB, session.id, 'object.updated', 'object', object.id).run();
  const updated = await objectForUser(c, session.id, object.id, false);
  return c.json({
    id: updated.id,
    folderId: updated.folder_id,
    name: updated.name,
    mime: updated.mime,
    size: updated.size,
    sha256: updated.sha256,
    partCount: updated.part_count,
    status: updated.status,
    createdAt: updated.created_at,
    updatedAt: updated.updated_at,
  });
});

app.post('/v1/folders', async (c) => {
  const session = await requireSession(c);
  const body = metadataOnly(record(await readJson<unknown>(c)));
  const { name, normalized } = normalizedName(body.name);
  const { workspace, folder: parent } = await folderForUser(c, session.id, optionalString(body.parentId, 'parentId'));
  const id = randomToken(18);
  try {
    const timestamp = now();
    const results = await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO folders (id, workspace_id, parent_id, name, normalized_name, path_key, created_at, updated_at)
        SELECT ?, p.workspace_id, p.id, ?, ?, ?, ?, ? FROM folders p
        WHERE p.id = ? AND p.workspace_id = ? AND p.deleted_at IS NULL`,
      ).bind(id, name, normalized, id, timestamp, timestamp, parent.id, workspace.id),
      audit(c.env.DB, session.id, 'folder.created', 'folder', id),
    ]);
    if (changes(results[0]) !== 1) fail(404, 'FOLDER_NOT_FOUND', 'Parent folder not found');
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (isConstraintError(error)) fail(409, 'FOLDER_EXISTS', 'Active folder with this name already exists');
    throw error;
  }
  return c.json({ id, name, parentId: parent.id });
});

app.patch('/v1/folders/:id', async (c) => {
  const session = await requireSession(c);
  const body = metadataOnly(record(await readJson<unknown>(c)));
  const existing = await folderForUser(c, session.id, c.req.param('id'));
  const nextName = body.name === undefined ? existing.folder.name : normalizedName(body.name).name;
  const nextNormalized = normalizedName(nextName).normalized;
  let parentId = existing.folder.parent_id;
  if (body.parentId !== undefined) parentId = optionalString(body.parentId, 'parentId') ?? null;
  if (parentId === existing.folder.id) fail(409, 'FOLDER_CYCLE', 'Folder cannot contain itself');
  if (body.parentId !== undefined) {
    if (existing.folder.parent_id === null && parentId !== null)
      fail(409, 'ROOT_FOLDER', 'Root folder cannot be moved');
    if (existing.folder.parent_id !== null && parentId === null)
      fail(409, 'ROOT_MOVE_FORBIDDEN', 'Non-root folder cannot become root');
  }
  if (parentId) {
    await folderForUser(c, session.id, parentId);
    const descendant = await first<{ found: number }>(
      c.env.DB,
      `
      WITH RECURSIVE descendants(id) AS (
        SELECT id FROM folders WHERE id = ?
        UNION ALL SELECT f.id FROM folders f JOIN descendants d ON f.parent_id = d.id WHERE f.deleted_at IS NULL
      ) SELECT 1 AS found FROM descendants WHERE id = ? LIMIT 1
    `,
      existing.folder.id,
      parentId,
    );
    if (descendant) fail(409, 'FOLDER_CYCLE', 'Folder move would create a cycle');
  }
  try {
    const timestamp = now();
    const results = await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE folders SET name = ?, normalized_name = ?, parent_id = ?, updated_at = ?
        WHERE id = ? AND deleted_at IS NULL
          AND (? IS NULL OR EXISTS (SELECT 1 FROM folders p WHERE p.id = ? AND p.workspace_id = folders.workspace_id AND p.deleted_at IS NULL))`,
      ).bind(nextName, nextNormalized, parentId, timestamp, existing.folder.id, parentId, parentId),
      audit(c.env.DB, session.id, 'folder.updated', 'folder', existing.folder.id),
    ]);
    if (changes(results[0]) !== 1) fail(409, 'FOLDER_PARENT_CLOSED', 'Parent folder is no longer active');
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (isConstraintError(error)) fail(409, 'FOLDER_EXISTS', 'Active folder with this name already exists');
    throw error;
  }
  return c.json({ id: existing.folder.id, name: nextName, parentId });
});

app.delete('/v1/folders/:id', async (c) => {
  const session = await requireSession(c);
  const existing = await folderForUser(c, session.id, c.req.param('id'));
  if (!existing.folder.parent_id) fail(409, 'ROOT_FOLDER', 'Root folder cannot be deleted');
  const timestamp = now();
  const result = await c.env.DB.prepare(
    `UPDATE folders SET deleted_at = ?, updated_at = ?
    WHERE id = ? AND deleted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM folders child WHERE child.parent_id = folders.id AND child.deleted_at IS NULL)
      AND NOT EXISTS (SELECT 1 FROM objects object WHERE object.folder_id = folders.id AND object.deleted_at IS NULL)`,
  )
    .bind(timestamp, timestamp, existing.folder.id)
    .run();
  if (changes(result) !== 1) fail(409, 'FOLDER_NOT_EMPTY', 'Folder must be empty before deletion');
  await audit(c.env.DB, session.id, 'folder.deleted', 'folder', existing.folder.id).run();
  return c.json({ ok: true });
});

app.post('/v1/folders/:id/restore', async (c) => {
  const session = await requireSession(c);
  const existing = await folderForUser(c, session.id, c.req.param('id'), true);
  if (!existing.folder.deleted_at) return c.json({ ok: true, restored: false });
  if (existing.folder.parent_id) await folderForUser(c, session.id, existing.folder.parent_id);
  try {
    const result = await c.env.DB.prepare(
      `UPDATE folders SET deleted_at = NULL, updated_at = ?
      WHERE id = ? AND deleted_at IS NOT NULL
        AND (parent_id IS NULL OR EXISTS (SELECT 1 FROM folders p WHERE p.id = folders.parent_id AND p.deleted_at IS NULL))`,
    )
      .bind(now(), existing.folder.id)
      .run();
    if (changes(result) !== 1) fail(409, 'FOLDER_PARENT_CLOSED', 'Parent folder is no longer active');
    await audit(c.env.DB, session.id, 'folder.restored', 'folder', existing.folder.id).run();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (isConstraintError(error)) fail(409, 'FOLDER_EXISTS', 'Active folder with this name already exists');
    throw error;
  }
  return c.json({ ok: true, restored: true });
});

app.delete('/v1/folders/:id/permanent', async (c) => {
  const session = await requireSession(c);
  const existing = await folderForUser(c, session.id, c.req.param('id'), true);
  if (!existing.folder.parent_id) fail(409, 'ROOT_FOLDER', 'Root folder cannot be deleted');
  if (!existing.folder.deleted_at)
    fail(409, 'FOLDER_NOT_SOFT_DELETED', 'Folder must be soft-deleted before permanent deletion');
  const result = await c.env.DB.prepare(
    `DELETE FROM folders
    WHERE id = ? AND deleted_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM folders child WHERE child.parent_id = folders.id)
      AND NOT EXISTS (SELECT 1 FROM objects object WHERE object.folder_id = folders.id)`,
  )
    .bind(existing.folder.id)
    .run();
  if (changes(result) !== 1) fail(409, 'FOLDER_NOT_EMPTY', 'Folder must be empty before permanent deletion');
  await audit(c.env.DB, session.id, 'folder.permanently_deleted', 'folder', existing.folder.id).run();
  return c.json({ ok: true });
});

app.post('/v1/uploads', async (c) => {
  const session = await requireSession(c);
  const body = metadataOnly(record(await readJson<unknown>(c)));
  const { name, normalized } = normalizedName(body.name);
  const size = integerValue(body.size, 'size', 0, Number.MAX_SAFE_INTEGER);
  const mime = stringValue(body.mime ?? 'application/octet-stream', 'mime', 128);
  const chunkSize = integerValue(body.chunkSize ?? 16 * 1024 * 1024, 'chunkSize', MIN_CHUNK_SIZE, MAX_CHUNK_SIZE);
  const expectedPartCount = integerValue(body.partCount, 'partCount', 0, MAX_PARTS);
  const expectedBySize = size === 0 ? 0 : Math.ceil(size / chunkSize);
  if (expectedPartCount !== expectedBySize)
    fail(422, 'PART_COUNT_MISMATCH', 'partCount does not match size and chunkSize');
  const sha256Value = hashValue(body.sha256, 'sha256');
  const idempotencyKey = stringValue(body.idempotencyKey, 'idempotencyKey', 200);
  const folderId = optionalString(body.folderId, 'folderId');
  const { workspace, folder } = await folderForUser(c, session.id, folderId);
  const existing = await first<UploadRow>(
    c.env.DB,
    `
    SELECT us.id, us.user_id, us.object_id, us.status, us.chunk_size, us.expected_part_count,
           us.idempotency_key, us.expires_at, o.name AS object_name, o.mime,
           o.size AS object_size, o.sha256 AS object_sha256, o.status AS object_status, o.deleted_at AS object_deleted_at, o.folder_id
    FROM upload_sessions us JOIN objects o ON o.id = us.object_id
    WHERE us.user_id = ? AND us.idempotency_key = ?
  `,
    session.id,
    idempotencyKey,
  );
  if (existing) {
    if (
      existing.object_name !== name ||
      existing.mime !== mime ||
      existing.object_size !== size ||
      existing.object_sha256 !== sha256Value ||
      existing.chunk_size !== chunkSize ||
      existing.expected_part_count !== expectedPartCount ||
      existing.folder_id !== folder.id
    ) {
      fail(409, 'UPLOAD_IDEMPOTENCY_CONFLICT', 'Idempotency key already belongs to another upload');
    }
    return c.json(uploadResponse(existing));
  }
  const objectId = randomToken(18);
  const uploadId = randomToken(18);
  const timestamp = now();
  const expires = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO objects (id, workspace_id, folder_id, name, normalized_name, mime, size, sha256, part_count, status, created_at, updated_at)
        SELECT ?, f.workspace_id, f.id, ?, ?, ?, ?, ?, ?, 'uploading', ?, ? FROM folders f
        WHERE f.id = ? AND f.workspace_id = ? AND f.deleted_at IS NULL`,
      ).bind(
        objectId,
        name,
        normalized,
        mime,
        size,
        sha256Value,
        expectedPartCount,
        timestamp,
        timestamp,
        folder.id,
        workspace.id,
      ),
      c.env.DB.prepare(
        `INSERT INTO upload_sessions (id, user_id, object_id, status, chunk_size, expected_part_count, idempotency_key, expires_at, created_at, updated_at)
        VALUES (?, ?, ?, 'created', ?, ?, ?, ?, ?, ?)`,
      ).bind(
        uploadId,
        session.id,
        objectId,
        chunkSize,
        expectedPartCount,
        idempotencyKey,
        expires,
        timestamp,
        timestamp,
      ),
      audit(c.env.DB, session.id, 'upload.started', 'object', objectId),
    ]);
  } catch (error) {
    if (isConstraintError(error)) {
      const raced = await first<UploadRow>(
        c.env.DB,
        `
        SELECT us.id, us.user_id, us.object_id, us.status, us.chunk_size, us.expected_part_count,
               us.idempotency_key, us.expires_at, o.name AS object_name, o.mime,
               o.size AS object_size, o.sha256 AS object_sha256, o.status AS object_status, o.deleted_at AS object_deleted_at, o.folder_id
        FROM upload_sessions us JOIN objects o ON o.id = us.object_id WHERE us.user_id = ? AND us.idempotency_key = ?
      `,
        session.id,
        idempotencyKey,
      );
      if (raced) {
        if (
          raced.object_name !== name ||
          raced.mime !== mime ||
          raced.object_size !== size ||
          raced.object_sha256 !== sha256Value ||
          raced.chunk_size !== chunkSize ||
          raced.expected_part_count !== expectedPartCount ||
          raced.folder_id !== folder.id
        ) {
          fail(409, 'UPLOAD_IDEMPOTENCY_CONFLICT', 'Idempotency key already belongs to another upload');
        }
        return c.json(uploadResponse(raced));
      }
      const activeFolder = await first<{ id: string }>(
        c.env.DB,
        'SELECT id FROM folders WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL',
        folder.id,
        workspace.id,
      );
      if (!activeFolder) fail(404, 'FOLDER_NOT_FOUND', 'Folder not found');
    }
    throw error;
  }
  return c.json({
    id: uploadId,
    objectId,
    status: 'created',
    chunkSize,
    expectedPartCount,
    expiresAt: expires,
    parts: [],
  });
});

function uploadResponse(upload: UploadRow) {
  return {
    id: upload.id,
    objectId: upload.object_id,
    status: upload.status,
    chunkSize: upload.chunk_size,
    expectedPartCount: upload.expected_part_count,
    expiresAt: upload.expires_at,
  };
}

app.get('/v1/uploads/:id', async (c) => {
  const session = await requireSession(c);
  const upload = await uploadForUser(c, session.id, c.req.param('id'));
  const parts = await all<PartRow>(
    c.env.DB,
    'SELECT id, object_id, part_no, size, sha256, message_id, bot_file_id, idempotency_key, created_at FROM object_parts WHERE object_id = ? ORDER BY part_no ASC',
    upload.object_id,
  );
  return c.json({
    ...uploadResponse(upload),
    object: {
      id: upload.object_id,
      name: upload.object_name,
      mime: upload.mime,
      size: upload.object_size,
      sha256: upload.object_sha256,
      status: upload.object_status,
    },
    parts: parts.map(partResponse),
  });
});

function partResponse(part: PartRow) {
  return {
    id: part.id,
    partNo: part.part_no,
    size: part.size,
    sha256: part.sha256,
    messageId: part.message_id,
    botFileId: part.bot_file_id,
    idempotencyKey: part.idempotency_key,
    createdAt: part.created_at,
  };
}

app.put('/v1/uploads/:id/parts/:no', async (c) => {
  const session = await requireSession(c);
  const upload = await uploadForUser(c, session.id, c.req.param('id'));
  const partNo = integerValue(Number(c.req.param('no')), 'partNo', 0, Math.max(0, upload.expected_part_count - 1));
  const body = metadataOnly(record(await readJson<unknown>(c)));
  const size = integerValue(body.size, 'size', 0, MAX_CHUNK_SIZE);
  const sha256Value = hashValue(body.sha256, 'sha256');
  const messageId = stringValue(body.messageId, 'messageId', 256);
  const botFileId = optionalString(body.botFileId, 'botFileId', 512);
  const idempotencyKey = stringValue(body.idempotencyKey, 'idempotencyKey', 200);
  if (upload.expected_part_count === 0) fail(409, 'NO_PARTS_EXPECTED', 'Empty upload has no parts to commit');
  const expectedSize =
    partNo === upload.expected_part_count - 1
      ? upload.object_size - upload.chunk_size * (upload.expected_part_count - 1)
      : upload.chunk_size;
  if (size !== expectedSize) fail(422, 'PART_SIZE_MISMATCH', 'Part size does not match upload manifest');
  const existing = await first<PartRow>(
    c.env.DB,
    'SELECT id, object_id, part_no, size, sha256, message_id, bot_file_id, idempotency_key, created_at FROM object_parts WHERE object_id = ? AND part_no = ?',
    upload.object_id,
    partNo,
  );
  const samePart = (part: PartRow): boolean =>
    part.size === size &&
    part.sha256 === sha256Value &&
    part.message_id === messageId &&
    part.bot_file_id === (botFileId ?? null) &&
    part.idempotency_key === idempotencyKey;
  if (existing) {
    if (!samePart(existing)) fail(409, 'PART_IDEMPOTENCY_CONFLICT', 'Part already committed with different metadata');
    return c.json(partResponse(existing));
  }
  const existingKey = await first<PartRow>(
    c.env.DB,
    'SELECT id, object_id, part_no, size, sha256, message_id, bot_file_id, idempotency_key, created_at FROM object_parts WHERE object_id = ? AND idempotency_key = ?',
    upload.object_id,
    idempotencyKey,
  );
  if (existingKey) {
    if (existingKey.part_no !== partNo || !samePart(existingKey))
      fail(409, 'PART_IDEMPOTENCY_CONFLICT', 'Idempotency key already belongs to another part');
    return c.json(partResponse(existingKey));
  }
  const current = now();
  if (!canCommitPart(upload.status, upload.object_status, upload.object_deleted_at, upload.expires_at, current)) {
    fail(409, 'UPLOAD_CLOSED', 'Upload session is closed');
  }
  const partId = randomToken(18);
  const timestamp = current;
  try {
    const results = await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO object_parts (id, object_id, part_no, size, sha256, message_id, bot_file_id, idempotency_key, created_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? FROM upload_sessions us JOIN objects o ON o.id = us.object_id
        WHERE us.id = ? AND us.status IN ('created', 'uploading', 'paused') AND us.expires_at > ?
          AND o.status = 'uploading' AND o.deleted_at IS NULL`,
      ).bind(
        partId,
        upload.object_id,
        partNo,
        size,
        sha256Value,
        messageId,
        botFileId ?? null,
        idempotencyKey,
        timestamp,
        upload.id,
        timestamp,
      ),
      c.env.DB.prepare(
        `UPDATE upload_sessions SET status = 'uploading', updated_at = ?
        WHERE id = ? AND status IN ('created', 'uploading', 'paused') AND expires_at > ?
          AND EXISTS (SELECT 1 FROM objects WHERE id = ? AND status = 'uploading' AND deleted_at IS NULL)`,
      ).bind(timestamp, upload.id, timestamp, upload.object_id),
      c.env.DB.prepare(
        `INSERT INTO audit_events (id, actor_id, action, target_type, target_id, created_at)
        SELECT ?, ?, 'upload.part_committed', 'object', ?, ? WHERE EXISTS (SELECT 1 FROM object_parts WHERE id = ?)`,
      ).bind(randomToken(18), session.id, upload.object_id, timestamp, partId),
    ]);
    if (changes(results[0]) !== 1 || changes(results[1]) !== 1) fail(409, 'UPLOAD_CLOSED', 'Upload session is closed');
  } catch (error) {
    if (error instanceof HttpError) {
      const raced = await first<PartRow>(
        c.env.DB,
        'SELECT id, object_id, part_no, size, sha256, message_id, bot_file_id, idempotency_key, created_at FROM object_parts WHERE object_id = ? AND part_no = ?',
        upload.object_id,
        partNo,
      );
      if (raced && samePart(raced)) return c.json(partResponse(raced));
      throw error;
    }
    if (isConstraintError(error)) {
      const raced = await first<PartRow>(
        c.env.DB,
        'SELECT id, object_id, part_no, size, sha256, message_id, bot_file_id, idempotency_key, created_at FROM object_parts WHERE object_id = ? AND part_no = ?',
        upload.object_id,
        partNo,
      );
      if (raced && samePart(raced)) return c.json(partResponse(raced));
      fail(409, 'PART_IDEMPOTENCY_CONFLICT', 'Part already committed with different metadata');
    }
    throw error;
  }
  return c.json({
    id: partId,
    partNo,
    size,
    sha256: sha256Value,
    messageId,
    botFileId: botFileId ?? null,
    idempotencyKey,
    createdAt: timestamp,
  });
});

app.post('/v1/uploads/:id/complete', async (c) => {
  const session = await requireSession(c);
  const upload = await uploadForUser(c, session.id, c.req.param('id'));
  const body = metadataOnly(record(await readJson<unknown>(c)));
  const requestedPartCount = integerValue(body.partCount, 'partCount', 0, MAX_PARTS);
  const requestedSize = integerValue(body.size, 'size');
  const requestedSha256 = hashValue(body.sha256, 'sha256');
  const sameCompletion =
    requestedPartCount === upload.expected_part_count &&
    requestedSize === upload.object_size &&
    requestedSha256 === upload.object_sha256;
  const terminal =
    upload.status === 'completed' ||
    ['aborted', 'failed'].includes(upload.status) ||
    upload.object_status === 'completed' ||
    upload.object_status === 'deleted' ||
    upload.object_status === 'aborted';
  if (terminal) {
    if (!sameCompletion) fail(409, 'COMPLETE_IDEMPOTENCY_CONFLICT', 'Completion metadata differs from upload manifest');
    if (upload.status === 'completed' && upload.object_status === 'completed') {
      return c.json({ objectId: upload.object_id, status: 'completed', idempotent: true });
    }
    if (upload.object_status === 'completed')
      return c.json({ objectId: upload.object_id, status: 'completed', idempotent: true });
    fail(409, 'UPLOAD_CLOSED', 'Upload session is closed');
  }
  if (
    !uploadIsOpen(upload.status, upload.expires_at, now()) ||
    !canComplete(upload.status, upload.object_status, upload.object_deleted_at, upload.expires_at, now())
  ) {
    fail(409, 'UPLOAD_CLOSED', 'Upload session is closed');
  }
  const parts = await all<PartRow>(
    c.env.DB,
    'SELECT id, object_id, part_no, size, sha256, message_id, bot_file_id, idempotency_key, created_at FROM object_parts WHERE object_id = ? ORDER BY part_no ASC',
    upload.object_id,
  );
  const validation = validateManifest({
    expectedPartCount: upload.expected_part_count,
    expectedSize: upload.object_size,
    expectedSha256: upload.object_sha256,
    parts: parts.map((part) => ({
      partNo: part.part_no,
      size: part.size,
      sha256: part.sha256,
      messageId: part.message_id,
      idempotencyKey: part.idempotency_key,
    })),
    requestedPartCount,
    requestedSize,
    requestedSha256,
  });
  if (!validation.valid) fail(422, 'MANIFEST_INVALID', validation.reason ?? 'Manifest is invalid');
  const timestamp = now();
  const results = await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE objects SET status = 'completed', updated_at = ? WHERE id = ? AND status = 'uploading' AND deleted_at IS NULL
      AND EXISTS (SELECT 1 FROM upload_sessions WHERE id = ? AND status IN ('created', 'uploading', 'paused', 'verifying') AND expires_at > ?)`,
    ).bind(timestamp, upload.object_id, upload.id, timestamp),
    c.env.DB.prepare(
      `UPDATE upload_sessions SET status = 'completed', updated_at = ? WHERE id = ?
      AND status IN ('created', 'uploading', 'paused', 'verifying') AND expires_at > ?
      AND EXISTS (SELECT 1 FROM objects WHERE id = ? AND status = 'completed')`,
    ).bind(timestamp, upload.id, timestamp, upload.object_id),
    c.env.DB.prepare(
      `INSERT INTO audit_events (id, actor_id, action, target_type, target_id, created_at)
      SELECT ?, ?, 'upload.completed', 'object', ?, ? WHERE EXISTS (SELECT 1 FROM objects WHERE id = ? AND status = 'completed' AND updated_at = ?)`,
    ).bind(randomToken(18), session.id, upload.object_id, timestamp, upload.object_id, timestamp),
  ]);
  if (changes(results[0]) !== 1 || changes(results[1]) !== 1) fail(409, 'UPLOAD_CLOSED', 'Upload session is closed');
  return c.json({ objectId: upload.object_id, status: 'completed', idempotent: false });
});

app.delete('/v1/uploads/:id', async (c) => {
  const session = await requireSession(c);
  const upload = await uploadForUser(c, session.id, c.req.param('id'));
  if (upload.status === 'completed') return c.json({ ok: true, status: 'completed' });
  if (upload.status === 'aborted') return c.json({ ok: true, status: 'aborted' });
  if (!canAbort(upload.status, upload.object_status, upload.object_deleted_at))
    fail(409, 'UPLOAD_CLOSED', 'Upload session is closed');
  const timestamp = now();
  const results = await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE upload_sessions SET status = 'aborted', updated_at = ? WHERE id = ?
      AND status IN ('created', 'uploading', 'paused', 'verifying', 'failed')`,
    ).bind(timestamp, upload.id),
    c.env.DB.prepare(
      `UPDATE objects SET status = 'aborted', updated_at = ? WHERE id = ? AND status = 'uploading' AND deleted_at IS NULL
      AND EXISTS (SELECT 1 FROM upload_sessions WHERE id = ? AND status = 'aborted')`,
    ).bind(timestamp, upload.object_id, upload.id),
    c.env.DB.prepare(
      `INSERT INTO audit_events (id, actor_id, action, target_type, target_id, created_at)
      SELECT ?, ?, 'upload.aborted', 'object', ?, ? WHERE EXISTS (SELECT 1 FROM upload_sessions WHERE id = ? AND status = 'aborted')`,
    ).bind(randomToken(18), session.id, upload.object_id, timestamp, upload.id),
  ]);
  if (changes(results[0]) !== 1 || changes(results[1]) !== 1) fail(409, 'UPLOAD_CLOSED', 'Upload session is closed');
  return c.json({ ok: true, status: 'aborted' });
});

app.get('/v1/objects/:id/manifest', async (c) => {
  const session = await requireSession(c);
  const object = await objectForUser(c, session.id, c.req.param('id'));
  const parts = await all<PartRow>(
    c.env.DB,
    'SELECT id, object_id, part_no, size, sha256, message_id, bot_file_id, idempotency_key, created_at FROM object_parts WHERE object_id = ? ORDER BY part_no ASC',
    object.id,
  );
  return c.json({
    object: {
      id: object.id,
      folderId: object.folder_id,
      name: object.name,
      mime: object.mime,
      size: object.size,
      sha256: object.sha256,
      partCount: object.part_count,
      status: object.status,
      deletedAt: object.deleted_at,
      createdAt: object.created_at,
      updatedAt: object.updated_at,
    },
    parts: parts.map(partResponse),
  });
});

app.delete('/v1/objects/:id', async (c) => {
  const session = await requireSession(c);
  const object = await objectForUser(c, session.id, c.req.param('id'));
  if (object.status === 'deleted') return c.json({ ok: true, deleted: true });
  if (object.status !== 'completed') fail(409, 'OBJECT_NOT_COMPLETE', 'Only completed objects can be deleted');
  const timestamp = now();
  const result = await c.env.DB.prepare(
    "UPDATE objects SET status = 'deleted', deleted_at = ?, updated_at = ? WHERE id = ? AND status = 'completed' AND deleted_at IS NULL",
  )
    .bind(timestamp, timestamp, object.id)
    .run();
  if (changes(result) !== 1) fail(409, 'OBJECT_STATE_CHANGED', 'Object state changed; retry');
  await audit(c.env.DB, session.id, 'object.deleted', 'object', object.id).run();
  return c.json({ ok: true, deleted: true });
});

app.post('/v1/objects/:id/restore', async (c) => {
  const session = await requireSession(c);
  const object = await objectForUser(c, session.id, c.req.param('id'));
  if (object.status !== 'deleted') return c.json({ ok: true, restored: false });
  const timestamp = now();
  const result = await c.env.DB.prepare(
    `UPDATE objects SET status = 'completed', deleted_at = NULL, updated_at = ?
    WHERE id = ? AND status = 'deleted' AND deleted_at IS NOT NULL
      AND EXISTS (SELECT 1 FROM folders f WHERE f.id = objects.folder_id AND f.deleted_at IS NULL)`,
  )
    .bind(timestamp, object.id)
    .run();
  if (changes(result) !== 1) fail(409, 'FOLDER_NOT_FOUND', 'Object folder is no longer active');
  await audit(c.env.DB, session.id, 'object.restored', 'object', object.id).run();
  return c.json({ ok: true, restored: true });
});

app.delete('/v1/objects/:id/permanent', async (c) => {
  const session = await requireSession(c);
  const object = await objectForUser(c, session.id, c.req.param('id'));
  if (object.status !== 'deleted' || !object.deleted_at)
    fail(409, 'OBJECT_NOT_SOFT_DELETED', 'Object must be soft-deleted before permanent deletion');
  const result = await c.env.DB.prepare(
    "DELETE FROM objects WHERE id = ? AND status = 'deleted' AND deleted_at IS NOT NULL",
  )
    .bind(object.id)
    .run();
  if (changes(result) < 1) {
    const current = await first<{ status: string; deleted_at: string | null }>(
      c.env.DB,
      `SELECT o.status, o.deleted_at
       FROM objects o JOIN workspaces w ON w.id = o.workspace_id
       WHERE o.id = ? AND w.owner_id = ?`,
      object.id,
      session.id,
    );
    if (!current) return c.json({ ok: true });
    if (current.status !== 'deleted' || !current.deleted_at)
      fail(409, 'OBJECT_NOT_SOFT_DELETED', 'Object must be soft-deleted before permanent deletion');
    fail(409, 'OBJECT_STATE_CHANGED', 'Object state changed; retry');
  }
  await audit(c.env.DB, session.id, 'object.permanently_deleted', 'object', object.id).run();
  return c.json({ ok: true });
});

app.get('/v1/export', async (c) => {
  const session = await requireSession(c);
  const workspace = await workspaceForUser(c, session.id);
  const folders = await all(
    c.env.DB,
    'SELECT id, parent_id, name, normalized_name, path_key, deleted_at, created_at, updated_at FROM folders WHERE workspace_id = ? ORDER BY id',
    workspace.id,
  );
  const objects = await all(
    c.env.DB,
    'SELECT id, folder_id, name, normalized_name, mime, size, sha256, part_count, status, deleted_at, created_at, updated_at FROM objects WHERE workspace_id = ? ORDER BY id',
    workspace.id,
  );
  const objectIds = (objects as { id: string }[]).map((object) => object.id);
  const parts =
    objectIds.length === 0
      ? []
      : await all(
          c.env.DB,
          `SELECT op.id, op.object_id, op.part_no, op.size, op.sha256, op.message_id, op.bot_file_id, op.idempotency_key, op.created_at
    FROM object_parts op JOIN objects o ON o.id = op.object_id WHERE o.workspace_id = ? ORDER BY op.object_id, op.part_no`,
          workspace.id,
        );
  return c.json({ exportedAt: now(), workspace, folders, objects, parts });
});

app.get('/v1/telegram/link', async (c) => {
  const session = await requireSession(c);
  const link = await first<{
    status: 'pending' | 'linked' | 'expired';
    expires_at: string;
    used_at: string | null;
    telegram_user_id: string | null;
    telegram_chat_id: string | null;
  }>(
    c.env.DB,
    `
    SELECT status, expires_at, used_at, telegram_user_id, telegram_chat_id
    FROM linking_codes WHERE user_id = ? ORDER BY created_at DESC LIMIT 1
  `,
    session.id,
  );
  if (!link) return c.json({ state: 'unlinked', permissionVerification: 'unimplemented' });
  const state = link.status === 'pending' && link.expires_at <= now() ? 'expired' : link.status;
  return c.json({
    state,
    expiresAt: link.expires_at,
    linkedAt: link.used_at,
    telegramUserId: link.telegram_user_id,
    telegramChatId: link.telegram_chat_id,
    permissionVerification: 'unimplemented',
  });
});

app.post('/v1/telegram/link', async (c) => {
  const session = await requireSession(c);
  requireConfig(c.env, 'APP_SESSION_SECRET');
  const code = randomToken(16);
  const expires = new Date(Date.now() + 10 * 60_000).toISOString();
  const timestamp = now();
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE linking_codes SET status = 'expired' WHERE user_id = ? AND status = 'pending'").bind(
      session.id,
    ),
    c.env.DB.prepare(
      `INSERT INTO linking_codes (id, user_id, code_hash, status, expires_at, created_at) VALUES (?, ?, ?, 'pending', ?, ?)`,
    ).bind(randomToken(18), session.id, await secretHash(code, c.env.APP_SESSION_SECRET), expires, timestamp),
  ]);
  return c.json({
    code,
    expiresAt: expires,
    state: 'link-pending',
    message: 'Send /link CODE to configured Telegram bot. Bot permission verification is not implemented.',
  });
});

app.post('/v1/webhooks/telegram', async (c) => {
  requireConfig(c.env, 'APP_SESSION_SECRET', 'TELEGRAM_WEBHOOK_SECRET');
  verifyTelegramWebhookSecret(c);
  const update = record(await readJson<unknown>(c));
  if (!update.message || typeof update.message !== 'object' || Array.isArray(update.message)) {
    return c.json({ ok: true, state: 'ignored' });
  }
  const message = record(update.message);
  const text = typeof message.text === 'string' ? message.text.trim() : '';
  const match = /^\/link(?:@[A-Za-z0-9_]+)?\s+([A-Za-z0-9_-]{16,128})$/u.exec(text);
  if (!match) return c.json({ ok: true, state: 'ignored' });
  const from = record(message.from);
  const chat = record(message.chat);
  const telegramUserId = stringValue(String(from.id), 'telegramUserId', 128);
  const telegramChatId = stringValue(String(chat.id), 'telegramChatId', 128);
  const codeHash = await secretHash(match[1], c.env.APP_SESSION_SECRET);
  const linked = await c.env.DB.prepare(
    `
    UPDATE linking_codes SET status = 'linked', used_at = ?, telegram_user_id = ?, telegram_chat_id = ?
    WHERE code_hash = ? AND status = 'pending' AND expires_at > ?
  `,
  )
    .bind(now(), telegramUserId, telegramChatId, codeHash, now())
    .run();
  if ((linked.meta?.changes ?? 0) !== 1) return c.json({ ok: true, state: 'ignored' });
  return c.json({
    ok: true,
    state: 'linked',
    permissionVerification: 'unimplemented',
    message: 'Telegram identifiers linked; bot/channel permissions still require explicit verification.',
  });
});

app.onError((error, c) => {
  const requestId = c.get('requestId') ?? 'unknown';
  const status = error instanceof HttpError ? error.status : 500;
  const code = error instanceof HttpError ? error.code : 'INTERNAL_ERROR';
  const message = error instanceof HttpError ? error.message : 'Internal server error';
  console.error(
    JSON.stringify(redactJson({ requestId, error: error instanceof Error ? error.name : 'unknown', code })),
  );
  c.header('X-Request-ID', requestId);
  applySecurityHeaders(c);
  if (isExactOrigin(c.req.header('Origin'), c.env.APP_ORIGIN)) {
    c.header('Access-Control-Allow-Origin', c.env.APP_ORIGIN);
    c.header('Access-Control-Allow-Credentials', 'true');
    c.header('Vary', 'Origin');
  }
  return c.json({ error: { code, message, requestId } }, status);
});

app.notFound((c) =>
  c.json({ error: { code: 'NOT_FOUND', message: 'Route not found', requestId: c.get('requestId') } }, 404),
);

export default app;
