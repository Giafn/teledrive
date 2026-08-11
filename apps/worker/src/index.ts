import { Hono, type Context } from 'hono';
import { createRemoteJWKSet, jwtVerify } from 'jose';
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
  sha256,
  sha256Base64url,
} from './security';
import type { AppEnv, Bindings, D1Database, PartRow, SessionRow, UploadRow, UserRow } from './types';
import { canAbort, canCommitPart, canComplete, uploadIsOpen } from './upload-state';
import { createMultipartStream, StreamingBodyError } from './bot-transfer';
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
const GOOGLE_OAUTH_STATE_COOKIE = '__Host-td_oauth_state';
const TELEGRAM_OAUTH_STATE_COOKIE = '__Host-td_telegram_oauth_state';
const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUER = 'https://accounts.google.com';
const GOOGLE_SCOPE = 'openid email profile';
const TELEGRAM_AUTH_ENDPOINT = 'https://oauth.telegram.org/auth';
const TELEGRAM_TOKEN_ENDPOINT = 'https://oauth.telegram.org/token';
const TELEGRAM_JWKS_URL = 'https://oauth.telegram.org/.well-known/jwks.json';
const TELEGRAM_ISSUER = 'https://oauth.telegram.org';
const TELEGRAM_SCOPE = 'openid';
const MAX_JSON_BYTES = 256 * 1024;
const MAX_GOOGLE_REGISTRATION_SECRET_LENGTH = 1024;
const MAX_TELEGRAM_REGISTRATION_SECRET_LENGTH = 1024;
const OIDC_CLOCK_TOLERANCE_SECONDS = 60;
const OIDC_MAX_TOKEN_AGE_SECONDS = 10 * 60;
const MAX_NAME_LENGTH = 255;
const MIN_CHUNK_SIZE = 8 * 1024 * 1024;
const MAX_CHUNK_SIZE = 19 * 1024 * 1024;
const MAX_PARTS = 100_000;
const SHA256 = /^[a-f0-9]{64}$/u;
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const authRate = new Map<string, { startedAt: number; count: number }>();

class HttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 422 | 429 | 500 | 502,
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
  const csrf = c.req.header('X-CSRF-Token');
  if (!csrf || csrf.length > 256) fail(403, 'CSRF_REQUIRED', 'CSRF token required');
  const session = await getSession(c);
  if (session) {
    const expected = await secretHash(csrf, c.env.APP_SESSION_SECRET);
    if (!constantTimeEqual(expected, session.csrf_hash)) fail(403, 'CSRF_INVALID', 'CSRF token invalid');
    return;
  }

  if (c.req.path === '/v1/auth/google/start' || c.req.path === '/v1/auth/telegram/start') {
    const cookieToken = requestCookie(c, CSRF_COOKIE);
    if (cookieToken && constantTimeEqual(cookieToken, csrf)) return;
  }
  fail(401, 'AUTH_REQUIRED', 'Authentication required');
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

export async function purgeOAuthTransactions(db: D1Database, at = Date.now()): Promise<void> {
  const expired = new Date(at).toISOString();
  const oldUsed = new Date(at - 10 * 60_000).toISOString();
  await db
    .prepare('DELETE FROM oauth_transactions WHERE expires_at <= ? OR (used_at IS NOT NULL AND used_at < ?)')
    .bind(expired, oldUsed)
    .run();
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

type WorkspaceAccess = { id: string; name: string; owner_id: string; is_owner: boolean };

type WorkspaceAccessRow = { id: string; name: string; owner_id: string; is_owner: number | boolean };

function workspaceAccess(row: WorkspaceAccessRow): WorkspaceAccess {
  return { ...row, is_owner: Boolean(row.is_owner) };
}

async function workspaceForUser(c: Context<AppEnv>, userId: string, workspaceId?: string): Promise<WorkspaceAccess> {
  const workspace = workspaceId
    ? await first<WorkspaceAccessRow>(
        c.env.DB,
        `
        SELECT w.id, w.name, w.owner_id, (w.owner_id = ?) AS is_owner
        FROM workspaces w
        WHERE w.id = ? AND (w.owner_id = ? OR EXISTS (
          SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = w.id AND wm.user_id = ?
        ))
      `,
        userId,
        workspaceId,
        userId,
        userId,
      )
    : await first<WorkspaceAccessRow>(
        c.env.DB,
        `
        SELECT w.id, w.name, w.owner_id, (w.owner_id = ?) AS is_owner
        FROM workspaces w
        WHERE w.owner_id = ? OR EXISTS (
          SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = w.id AND wm.user_id = ?
        )
        ORDER BY CASE WHEN w.owner_id = ? THEN 0 ELSE 1 END, w.id
        LIMIT 1
      `,
        userId,
        userId,
        userId,
        userId,
      );
  if (!workspace) fail(404, 'WORKSPACE_NOT_FOUND', 'Workspace not found');
  return workspaceAccess(workspace);
}

async function accessibleWorkspaces(c: Context<AppEnv>, userId: string): Promise<WorkspaceAccess[]> {
  const rows = await all<WorkspaceAccessRow>(
    c.env.DB,
    `
    SELECT w.id, w.name, w.owner_id, (w.owner_id = ?) AS is_owner
    FROM workspaces w
    WHERE w.owner_id = ? OR EXISTS (
      SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = w.id AND wm.user_id = ?
    )
    ORDER BY CASE WHEN w.owner_id = ? THEN 0 ELSE 1 END, w.id
  `,
    userId,
    userId,
    userId,
    userId,
  );
  return rows.map(workspaceAccess);
}

async function workspaceMembers(c: Context<AppEnv>, workspace: WorkspaceAccess) {
  const owner = await first<{ username: string; display_name: string; status: UserRow['status'] }>(
    c.env.DB,
    'SELECT username, display_name, status FROM users WHERE id = ?',
    workspace.owner_id,
  );
  const rows = await all<{
    user_id: string;
    username: string;
    display_name: string;
    status: UserRow['status'];
    created_at: string;
  }>(
    c.env.DB,
    `
    SELECT wm.user_id, u.username, u.display_name, u.status, wm.created_at
    FROM workspace_members wm JOIN users u ON u.id = wm.user_id
    WHERE wm.workspace_id = ?
    ORDER BY wm.created_at, wm.user_id
  `,
    workspace.id,
  );
  return [
    {
      userId: workspace.owner_id,
      username: owner?.username ?? null,
      displayName: owner?.display_name ?? null,
      status: owner?.status,
      role: 'owner' as const,
      createdAt: null,
    },
    ...rows.map((row) => ({
      userId: row.user_id,
      username: row.username,
      displayName: row.display_name,
      status: row.status,
      role: 'member' as const,
      createdAt: row.created_at,
    })),
  ];
}

function requireWorkspaceOwner(workspace: WorkspaceAccess): void {
  if (!workspace.is_owner) fail(403, 'WORKSPACE_OWNER_REQUIRED', 'Workspace owner required');
}

async function folderForUser(c: Context<AppEnv>, userId: string, folderId: string | undefined, includeDeleted = false) {
  const folder = folderId
    ? await first<{
        id: string;
        workspace_id: string;
        parent_id: string | null;
        name: string;
        normalized_name: string;
        deleted_at: string | null;
      }>(c.env.DB, 'SELECT id, workspace_id, parent_id, name, normalized_name, deleted_at FROM folders WHERE id = ?', folderId)
    : null;
  const workspace = folder
    ? await workspaceForUser(c, userId, folder.workspace_id)
    : await workspaceForUser(c, userId);
  const resolvedFolder = folder
    ? folder
    : await first<{
        id: string;
        workspace_id: string;
        parent_id: string | null;
        name: string;
        normalized_name: string;
        deleted_at: string | null;
      }>(
        c.env.DB,
        `
        SELECT id, workspace_id, parent_id, name, normalized_name, deleted_at
        FROM folders WHERE workspace_id = ? AND parent_id IS NULL
        ${includeDeleted ? '' : 'AND deleted_at IS NULL'}
      `,
        workspace.id,
      );
  if (!resolvedFolder || (!includeDeleted && resolvedFolder.deleted_at)) fail(404, 'FOLDER_NOT_FOUND', 'Folder not found');
  return { workspace, folder: resolvedFolder };
}

async function uploadForUser(c: Context<AppEnv>, userId: string, uploadId: string): Promise<UploadRow> {
  const upload = await first<UploadRow & { workspace_id: string }>(
    c.env.DB,
    `
    SELECT us.id, us.user_id, us.object_id, us.status, us.chunk_size, us.expected_part_count,
           us.idempotency_key, us.expires_at, o.name AS object_name, o.mime,
           o.size AS object_size, o.sha256 AS object_sha256, o.status AS object_status, o.deleted_at AS object_deleted_at,
           o.folder_id, o.workspace_id
    FROM upload_sessions us JOIN objects o ON o.id = us.object_id
    WHERE us.id = ? AND us.user_id = ?
  `,
    uploadId,
    userId,
  );
  if (!upload) fail(404, 'UPLOAD_NOT_FOUND', 'Upload session not found');
  await workspaceForUser(c, userId, upload.workspace_id);
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
    FROM objects o WHERE o.id = ?
  `,
    objectId,
  );
  if (!object) fail(404, 'OBJECT_NOT_FOUND', 'Object not found');
  const workspace = await workspaceForUser(c, userId, object.workspace_id);
  if (!includeDeleted && object.deleted_at) fail(404, 'OBJECT_NOT_FOUND', 'Object not found');
  return { ...object, is_owner: workspace.is_owner };
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
    c.header(
      'Access-Control-Allow-Headers',
      'Content-Type, X-CSRF-Token, X-Bootstrap-Token, X-Request-ID, X-Part-Size, X-Part-SHA256, X-Idempotency-Key',
    );
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
  if (MUTATING_METHODS.has(c.req.method) && !c.req.path.startsWith('/v1/webhooks/telegram')) {
    if (!isExactOrigin(c.req.header('Origin'), c.env.APP_ORIGIN))
      fail(403, 'ORIGIN_REQUIRED', 'Exact application origin required');
    await validateMutationCsrf(c);
  }
  await next();
});

app.use('/v1/auth/google/start', async (c, next) => {
  rateLimitAuth(c);
  await next();
});

app.use('/v1/auth/telegram/start', async (c, next) => {
  rateLimitAuth(c);
  await next();
});

app.use('*', async (c, next) => {
  if (MUTATING_METHODS.has(c.req.method) && c.req.method !== 'DELETE') {
    const contentType = c.req.header('Content-Type')?.split(';', 1)[0].trim().toLowerCase();
    if (c.req.method === 'PUT' && /^\/v1\/bot\/uploads\/[^/]+\/parts\/\d+$/u.test(c.req.path)) {
      await next();
      return;
    }
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

app.post('/v1/auth/logout', async (c) => {
  const session = await requireSession(c);
  await c.env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(session.session_id).run();
  c.header('Set-Cookie', serializeCookie(SESSION_COOKIE, '', { httpOnly: true, maxAge: 0, sameSite: 'Lax' }));
  c.header('Set-Cookie', serializeCookie(CSRF_COOKIE, '', { maxAge: 0, sameSite: 'Lax' }), { append: true });
  return c.json({ ok: true });
});

async function googleRedirect(c: Context<AppEnv>, error?: string): Promise<Response> {
  const url = new URL(c.env.APP_ORIGIN);
  if (error) url.searchParams.set('error', error);
  return c.redirect(url.toString(), 302);
}

async function telegramRedirect(c: Context<AppEnv>, error?: string): Promise<Response> {
  c.header(
    'Set-Cookie',
    serializeCookie(TELEGRAM_OAUTH_STATE_COOKIE, '', { httpOnly: true, maxAge: 0, sameSite: 'Lax' }),
    { append: true },
  );
  const url = new URL(c.env.APP_ORIGIN);
  if (error) url.searchParams.set('error', error);
  return c.redirect(url.toString(), 302);
}

app.post('/v1/auth/google/start', async (c) => {
  requireConfig(c.env, 'APP_ORIGIN', 'APP_SESSION_SECRET', 'GOOGLE_CLIENT_ID', 'GOOGLE_CALLBACK_URL');
  const body = record(await readJson<unknown>(c));
  const mode =
    body.mode === 'register'
      ? 'register'
      : body.mode === 'link'
        ? 'link'
        : body.mode === 'login'
          ? 'login'
          : fail(422, 'INVALID_FIELD', 'mode is invalid');
  if (mode === 'register') {
    requireConfig(c.env, 'GOOGLE_REGISTRATION_SECRET');
    const secretInfo = stringValue(body.secretInfo, 'secretInfo', MAX_GOOGLE_REGISTRATION_SECRET_LENGTH);
    const [providedDigest, expectedDigest] = await Promise.all([
      sha256(secretInfo),
      sha256(c.env.GOOGLE_REGISTRATION_SECRET),
    ]);
    if (!constantTimeEqual(providedDigest, expectedDigest))
      fail(403, 'REGISTRATION_SECRET_INVALID', 'Registration secret is invalid');
  }
  await purgeOAuthTransactions(c.env.DB);
  let userId: string | null = null;
  let issuedSessionId: string | null = null;
  if (mode === 'link') {
    const session = await requireSession(c);
    userId = session.id;
    issuedSessionId = session.session_id;
  }
  const state = randomToken(24);
  const nonce = randomToken(16);
  const verifier = randomToken(32);
  const challenge = await sha256Base64url(verifier);
  const timestamp = now();
  const expires = new Date(Date.now() + 10 * 60_000).toISOString();
  await c.env.DB.prepare(
    `
    INSERT INTO oauth_transactions (id, provider, state_hash, nonce_hash, code_verifier, mode, user_id, issued_session_id, expires_at, used_at, created_at)
    VALUES (?, 'google', ?, ?, ?, ?, ?, ?, ?, NULL, ?)
  `,
  )
    .bind(
      randomToken(18),
      await secretHash(state, c.env.APP_SESSION_SECRET),
      await secretHash(nonce, c.env.APP_SESSION_SECRET),
      verifier,
      mode,
      userId,
      issuedSessionId,
      expires,
      timestamp,
    )
    .run();
  c.header(
    'Set-Cookie',
    serializeCookie(GOOGLE_OAUTH_STATE_COOKIE, state, { httpOnly: true, maxAge: 600, sameSite: 'Lax' }),
  );
  const params = new URLSearchParams({
    client_id: c.env.GOOGLE_CLIENT_ID!,
    redirect_uri: c.env.GOOGLE_CALLBACK_URL!,
    response_type: 'code',
    scope: GOOGLE_SCOPE,
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  return c.json({ authorizationUrl: `${GOOGLE_AUTH_ENDPOINT}?${params.toString()}` });
});

app.get('/v1/auth/google/callback', async (c) => {
  requireConfig(
    c.env,
    'APP_ORIGIN',
    'APP_SESSION_SECRET',
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
    'GOOGLE_CALLBACK_URL',
  );
  const stateParam = c.req.query('state');
  const code = c.req.query('code');
  const googleError = c.req.query('error');
  const stateCookie = requestCookie(c, GOOGLE_OAUTH_STATE_COOKIE);
  if (!stateParam || !stateCookie || !constantTimeEqual(stateCookie, stateParam))
    return googleRedirect(c, 'google_failed');
  const stateHash = await secretHash(stateParam, c.env.APP_SESSION_SECRET);
  const claimed = await c.env.DB.prepare(
    `
    UPDATE oauth_transactions SET used_at = ?
    WHERE provider = 'google' AND state_hash = ? AND used_at IS NULL AND expires_at > ?
  `,
  )
    .bind(now(), stateHash, now())
    .run();
  if (changes(claimed) !== 1) return googleRedirect(c, 'google_failed');
  c.header(
    'Set-Cookie',
    serializeCookie(GOOGLE_OAUTH_STATE_COOKIE, '', { httpOnly: true, maxAge: 0, sameSite: 'Lax' }),
  );
  if (googleError === 'access_denied') return googleRedirect(c, 'google_denied');
  if (googleError || !code) return googleRedirect(c, 'google_failed');
  const tx = await first<{
    id: string;
    nonce_hash: string;
    code_verifier: string;
    mode: 'login' | 'link' | 'register';
    user_id: string | null;
    issued_session_id: string | null;
  }>(
    c.env.DB,
    "SELECT id, nonce_hash, code_verifier, mode, user_id, issued_session_id FROM oauth_transactions WHERE provider = 'google' AND state_hash = ?",
    stateHash,
  );
  if (!tx) return googleRedirect(c, 'google_failed');
  const tokenResponse = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: c.env.GOOGLE_CLIENT_ID!,
      client_secret: c.env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: c.env.GOOGLE_CALLBACK_URL!,
      grant_type: 'authorization_code',
      code_verifier: tx.code_verifier,
    }),
  });
  const tokenJson = (await tokenResponse.json().catch(() => ({}))) as Record<string, unknown>;
  const idToken = tokenJson.id_token;
  if (!tokenResponse.ok || typeof idToken !== 'string' || idToken.length > 16_384)
    return googleRedirect(c, 'google_failed');
  let payload: Awaited<ReturnType<typeof jwtVerify>>['payload'];
  try {
    const jwks = createRemoteJWKSet(new URL(GOOGLE_JWKS_URL));
    const verification = await jwtVerify(idToken, jwks, {
      issuer: GOOGLE_ISSUER,
      audience: c.env.GOOGLE_CLIENT_ID,
      algorithms: ['RS256'],
    });
    payload = verification.payload;
  } catch {
    return googleRedirect(c, 'google_failed');
  }
  const nonce = payload.nonce;
  if (typeof nonce !== 'string' || !constantTimeEqual(await secretHash(nonce, c.env.APP_SESSION_SECRET), tx.nonce_hash))
    return googleRedirect(c, 'google_failed');
  const issuer = payload.iss;
  const subject = payload.sub;
  if (issuer !== GOOGLE_ISSUER || typeof subject !== 'string' || subject.length === 0)
    return googleRedirect(c, 'google_failed');
  const identity = await first<{ user_id: string }>(
    c.env.DB,
    "SELECT user_id FROM auth_identities WHERE provider = 'google' AND issuer = ? AND subject = ?",
    issuer,
    subject,
  );
  if (tx.mode === 'link') {
    const session = await getSession(c);
    if (!session || session.session_id !== tx.issued_session_id || session.id !== tx.user_id)
      return googleRedirect(c, 'google_link_failed');
    if (identity && identity.user_id !== session.id) return googleRedirect(c, 'google_link_failed');
    if (!identity) {
      await c.env.DB.prepare(
        "INSERT INTO auth_identities (id, user_id, provider, issuer, subject, created_at, last_used_at) VALUES (?, ?, 'google', ?, ?, ?, ?)",
      )
        .bind(randomToken(18), session.id, issuer, subject, now(), now())
        .run();
    }
    return googleRedirect(c);
  }
  if (identity) {
    const user = await first<UserRow>(
      c.env.DB,
      "SELECT id, username, display_name, status FROM users WHERE id = ? AND status = 'active'",
      identity.user_id,
    );
    if (!user) return googleRedirect(c, 'google_failed');
    await setSession(c, user.id);
    return googleRedirect(c);
  }
  if (tx.mode !== 'register') return googleRedirect(c, 'google_failed');
  const email = typeof payload.email === 'string' ? payload.email : '';
  const emailLocal = email.split('@')[0] ?? '';
  const baseUsername = emailLocal.toLocaleLowerCase('en-US').replace(/[^a-z0-9._-]+/gu, '') || 'user';
  const displayName = typeof payload.name === 'string' && payload.name ? payload.name : emailLocal;
  const username = await uniqueUsername(c.env.DB, baseUsername);
  const userId = randomToken(18);
  const created = now();
  const workspaceId = randomToken(18);
  const rootId = randomToken(18);
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        "INSERT INTO users (id, username, display_name, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)",
      ).bind(userId, username, displayName, created, created),
      c.env.DB.prepare(
        "INSERT INTO auth_identities (id, user_id, provider, issuer, subject, created_at, last_used_at) VALUES (?, ?, 'google', ?, ?, ?, ?)",
      ).bind(randomToken(18), userId, issuer, subject, created, created),
      c.env.DB.prepare(
        "INSERT INTO workspaces (id, owner_id, name, created_at, updated_at) VALUES (?, ?, 'My Drive', ?, ?)",
      ).bind(workspaceId, userId, created, created),
      c.env.DB.prepare(
        `INSERT INTO folders (id, workspace_id, parent_id, name, normalized_name, path_key, created_at, updated_at)
        VALUES (?, ?, NULL, 'My Drive', 'my drive', ?, ?, ?)`,
      ).bind(rootId, workspaceId, rootId, created, created),
      c.env.DB.prepare(
        "INSERT INTO audit_events (id, actor_id, action, target_type, target_id, created_at) VALUES (?, ?, 'google.registered', 'user', ?, ?)",
      ).bind(randomToken(18), userId, userId, created),
    ]);
  } catch (error) {
    if (isConstraintError(error)) fail(409, 'GOOGLE_IDENTITY_EXISTS', 'Google account is already registered');
    throw error;
  }
  await setSession(c, userId);
  return googleRedirect(c);
});

async function uniqueUsername(db: D1Database, base: string): Promise<string> {
  let username = base.slice(0, 128);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const existing = await first<{ id: string }>(db, 'SELECT id FROM users WHERE username = ?', username);
    if (!existing) return username;
    username = `${base.slice(0, 100)}-${randomToken(6)}`;
  }
  fail(500, 'USERNAME_EXHAUSTED', 'Could not allocate a unique username');
}

function hasAudience(value: unknown, expected: string): boolean {
  return value === expected || (Array.isArray(value) && value.every((item) => typeof item === 'string') && value.includes(expected));
}

function validTelegramTokenTimes(payload: Awaited<ReturnType<typeof jwtVerify>>['payload']): boolean {
  const exp = payload.exp;
  const iat = payload.iat;
  const current = Math.floor(Date.now() / 1000);
  if (typeof exp !== 'number' || typeof iat !== 'number' || !Number.isSafeInteger(exp) || !Number.isSafeInteger(iat))
    return false;
  if (exp <= current - OIDC_CLOCK_TOLERANCE_SECONDS || exp <= iat) return false;
  return iat >= current - OIDC_MAX_TOKEN_AGE_SECONDS - OIDC_CLOCK_TOLERANCE_SECONDS && iat <= current + OIDC_CLOCK_TOLERANCE_SECONDS;
}

function telegramOidcDiagnostic(
  stage: string,
  result: string,
  metadata: Record<string, string | boolean> = {},
): void {
  console.info('telegram_oidc', { stage, result, ...metadata });
}

function telegramStatusClass(status: number): string {
  const family = Math.floor(status / 100);
  return family >= 1 && family <= 5 ? `${family}xx` : 'other';
}

function telegramErrorClass(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  return /^[A-Za-z][A-Za-z0-9_$]*$/u.test(name) ? name : 'UnknownError';
}

function telegramJwtHeader(token: string): { alg: string; kid: string } {
  try {
    const encoded = token.split('.', 1)[0] ?? '';
    const normalized = encoded.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(encoded.length / 4) * 4, '=');
    const decoded = JSON.parse(atob(normalized)) as unknown;
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) throw new Error('invalid header');
    const header = decoded as Record<string, unknown>;
    return {
      alg: typeof header.alg === 'string' && header.alg.length <= 32 ? header.alg : 'missing',
      kid: typeof header.kid === 'string' && header.kid.length <= 256 ? header.kid : 'missing',
    };
  } catch {
    return { alg: 'invalid', kid: 'missing' };
  }
}

app.post('/v1/auth/telegram/start', async (c) => {
  requireConfig(c.env, 'APP_ORIGIN', 'APP_SESSION_SECRET', 'TELEGRAM_LOGIN_CLIENT_ID', 'TELEGRAM_LOGIN_CALLBACK_URL');
  const body = record(await readJson<unknown>(c));
  const mode =
    body.mode === 'register'
      ? 'register'
      : body.mode === 'login'
        ? 'login'
        : fail(422, 'INVALID_FIELD', 'mode is invalid');
  if (mode === 'register') {
    requireConfig(c.env, 'TELEGRAM_REGISTRATION_SECRET');
    const secretInfo = stringValue(body.secretInfo, 'secretInfo', MAX_TELEGRAM_REGISTRATION_SECRET_LENGTH);
    const [providedDigest, expectedDigest] = await Promise.all([
      sha256(secretInfo),
      sha256(c.env.TELEGRAM_REGISTRATION_SECRET!),
    ]);
    if (!constantTimeEqual(providedDigest, expectedDigest))
      fail(403, 'REGISTRATION_SECRET_INVALID', 'Registration secret is invalid');
  }
  await purgeOAuthTransactions(c.env.DB);
  const state = randomToken(24);
  const nonce = randomToken(16);
  const verifier = randomToken(32);
  const challenge = await sha256Base64url(verifier);
  const timestamp = now();
  const expires = new Date(Date.now() + 10 * 60_000).toISOString();
  await c.env.DB.prepare(
    `
    INSERT INTO oauth_transactions (id, provider, state_hash, nonce_hash, code_verifier, mode, user_id, issued_session_id, expires_at, used_at, created_at)
    VALUES (?, 'telegram', ?, ?, ?, ?, NULL, NULL, ?, NULL, ?)
  `,
  )
    .bind(
      randomToken(18),
      await secretHash(state, c.env.APP_SESSION_SECRET),
      await secretHash(nonce, c.env.APP_SESSION_SECRET),
      verifier,
      mode,
      expires,
      timestamp,
    )
    .run();
  c.header(
    'Set-Cookie',
    serializeCookie(TELEGRAM_OAUTH_STATE_COOKIE, state, { httpOnly: true, maxAge: 600, sameSite: 'Lax' }),
  );
  const params = new URLSearchParams({
    client_id: c.env.TELEGRAM_LOGIN_CLIENT_ID!,
    redirect_uri: c.env.TELEGRAM_LOGIN_CALLBACK_URL!,
    response_type: 'code',
    scope: TELEGRAM_SCOPE,
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  return c.json({ authorizationUrl: `${TELEGRAM_AUTH_ENDPOINT}?${params.toString()}` });
});

app.get('/v1/auth/telegram/callback', async (c) => {
  requireConfig(
    c.env,
    'APP_ORIGIN',
    'APP_SESSION_SECRET',
    'TELEGRAM_LOGIN_CLIENT_ID',
    'TELEGRAM_LOGIN_CLIENT_SECRET',
    'TELEGRAM_LOGIN_CALLBACK_URL',
  );
  const stateParam = c.req.query('state');
  const code = c.req.query('code');
  const telegramError = c.req.query('error');
  const stateCookie = requestCookie(c, TELEGRAM_OAUTH_STATE_COOKIE);
  if (!stateParam || !stateCookie || !constantTimeEqual(stateCookie, stateParam)) {
    telegramOidcDiagnostic(
      'callback_state',
      !stateParam ? 'missing_state' : !stateCookie ? 'missing_cookie' : 'state_mismatch',
    );
    return telegramRedirect(c, 'telegram_failed');
  }

  const stateHash = await secretHash(stateParam, c.env.APP_SESSION_SECRET);
  const claimed = await c.env.DB.prepare(
    `
    UPDATE oauth_transactions SET used_at = ?
    WHERE provider = 'telegram' AND state_hash = ? AND used_at IS NULL AND expires_at > ?
  `,
  )
    .bind(now(), stateHash, now())
    .run();
  if (changes(claimed) !== 1) {
    telegramOidcDiagnostic('callback_state', 'replay_or_expired');
    return telegramRedirect(c, 'telegram_failed');
  }
  telegramOidcDiagnostic('callback_state', 'accepted');
  if (telegramError === 'access_denied') {
    telegramOidcDiagnostic('callback_params', 'provider_denied');
    return telegramRedirect(c, 'telegram_denied');
  }
  if (telegramError) {
    telegramOidcDiagnostic('callback_params', 'provider_error');
    return telegramRedirect(c, 'telegram_failed');
  }
  if (!code) {
    telegramOidcDiagnostic('callback_params', 'missing_code');
    return telegramRedirect(c, 'telegram_failed');
  }

  const tx = await first<{
    id: string;
    nonce_hash: string;
    code_verifier: string;
    mode: 'login' | 'link' | 'register';
  }>(
    c.env.DB,
    "SELECT id, nonce_hash, code_verifier, mode FROM oauth_transactions WHERE provider = 'telegram' AND state_hash = ?",
    stateHash,
  );
  if (!tx) {
    telegramOidcDiagnostic('callback_state', 'transaction_missing');
    return telegramRedirect(c, 'telegram_failed');
  }

  let tokenResponse: Response;
  try {
    tokenResponse = await fetch(TELEGRAM_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${btoa(`${c.env.TELEGRAM_LOGIN_CLIENT_ID}:${c.env.TELEGRAM_LOGIN_CLIENT_SECRET}`)}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        code,
        redirect_uri: c.env.TELEGRAM_LOGIN_CALLBACK_URL!,
        grant_type: 'authorization_code',
        code_verifier: tx.code_verifier,
      }),
    });
  } catch (error) {
    telegramOidcDiagnostic('token_exchange', 'transport_failure', {
      statusClass: 'network_error',
      errorClass: telegramErrorClass(error),
    });
    return telegramRedirect(c, 'telegram_failed');
  }
  const statusClass = telegramStatusClass(tokenResponse.status);
  let tokenJson: Record<string, unknown>;
  try {
    const parsed = await tokenResponse.json();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid token response');
    tokenJson = parsed as Record<string, unknown>;
  } catch {
    telegramOidcDiagnostic('token_exchange', 'invalid_json', { statusClass });
    return telegramRedirect(c, 'telegram_failed');
  }
  const idToken = tokenJson.id_token;
  if (!tokenResponse.ok) {
    telegramOidcDiagnostic('token_exchange', 'http_failure', { statusClass });
    return telegramRedirect(c, 'telegram_failed');
  }
  if (typeof idToken !== 'string' || idToken.length > 16_384) {
    telegramOidcDiagnostic('token_exchange', 'invalid_id_token', { statusClass });
    return telegramRedirect(c, 'telegram_failed');
  }
  telegramOidcDiagnostic('token_exchange', 'success', { statusClass });
  telegramOidcDiagnostic('jwt_header', 'observed', telegramJwtHeader(idToken));

  let verification: Awaited<ReturnType<typeof jwtVerify>>;
  try {
    const jwks = createRemoteJWKSet(new URL(TELEGRAM_JWKS_URL));
    verification = await jwtVerify(idToken, jwks, {
      issuer: TELEGRAM_ISSUER,
      audience: c.env.TELEGRAM_LOGIN_CLIENT_ID,
      algorithms: ['RS256'],
      clockTolerance: OIDC_CLOCK_TOLERANCE_SECONDS,
      maxTokenAge: OIDC_MAX_TOKEN_AGE_SECONDS,
      requiredClaims: ['iss', 'sub', 'aud', 'exp', 'iat'],
    });
  } catch (error) {
    telegramOidcDiagnostic('verification', 'failed', { errorClass: telegramErrorClass(error) });
    return telegramRedirect(c, 'telegram_failed');
  }
  telegramOidcDiagnostic('verification', 'success');
  if (verification.protectedHeader?.alg !== 'RS256') {
    telegramOidcDiagnostic('jwt_header', 'unsupported_alg');
    return telegramRedirect(c, 'telegram_failed');
  }
  const payload = verification.payload;
  if (payload.iss !== TELEGRAM_ISSUER) {
    telegramOidcDiagnostic('claims', 'mismatch', { category: 'issuer' });
    return telegramRedirect(c, 'telegram_failed');
  }
  if (!hasAudience(payload.aud, c.env.TELEGRAM_LOGIN_CLIENT_ID!)) {
    telegramOidcDiagnostic('claims', 'mismatch', { category: 'audience' });
    return telegramRedirect(c, 'telegram_failed');
  }
  if (!validTelegramTokenTimes(payload)) {
    telegramOidcDiagnostic('claims', 'mismatch', { category: 'time' });
    return telegramRedirect(c, 'telegram_failed');
  }
  const nonce = payload.nonce;
  if (typeof nonce !== 'string' || !constantTimeEqual(await secretHash(nonce, c.env.APP_SESSION_SECRET), tx.nonce_hash)) {
    telegramOidcDiagnostic('claims', 'mismatch', { category: 'nonce' });
    return telegramRedirect(c, 'telegram_failed');
  }
  const subject = payload.sub;
  if (typeof subject !== 'string' || subject.length === 0 || subject.length > 512) {
    telegramOidcDiagnostic('claims', 'mismatch', { category: 'subject' });
    return telegramRedirect(c, 'telegram_failed');
  }
  if (tx.mode !== 'login' && tx.mode !== 'register') {
    telegramOidcDiagnostic('claims', 'mismatch', { category: 'mode' });
    return telegramRedirect(c, 'telegram_failed');
  }

  const identity = await first<{ user_id: string }>(
    c.env.DB,
    "SELECT user_id FROM auth_identities WHERE provider = 'telegram' AND issuer = ? AND subject = ?",
    TELEGRAM_ISSUER,
    subject,
  );
  telegramOidcDiagnostic('identity_persistence', identity ? 'found' : 'missing');
  if (tx.mode === 'login') {
    if (!identity) {
      telegramOidcDiagnostic('identity_persistence', 'login_identity_missing');
      return telegramRedirect(c, 'telegram_failed');
    }
    const user = await first<UserRow>(
      c.env.DB,
      "SELECT id, username, display_name, status FROM users WHERE id = ? AND status = 'active'",
      identity.user_id,
    );
    if (!user) {
      telegramOidcDiagnostic('identity_persistence', 'user_missing');
      return telegramRedirect(c, 'telegram_failed');
    }
    try {
      await c.env.DB.prepare(
        'UPDATE auth_identities SET last_used_at = ? WHERE provider = ? AND issuer = ? AND subject = ?',
      )
        .bind(now(), 'telegram', TELEGRAM_ISSUER, subject)
        .run();
      telegramOidcDiagnostic('identity_persistence', 'last_used_updated');
      await setSession(c, user.id);
      telegramOidcDiagnostic('session_persistence', 'created');
    } catch (error) {
      telegramOidcDiagnostic('session_persistence', 'failed', { errorClass: telegramErrorClass(error) });
      throw error;
    }
    return telegramRedirect(c);
  }
  if (identity) {
    telegramOidcDiagnostic('identity_persistence', 'already_exists');
    return telegramRedirect(c, 'telegram_failed');
  }

  const username = await uniqueUsername(c.env.DB, `telegram-${randomToken(9).toLowerCase()}`);
  const userId = randomToken(18);
  const created = now();
  const workspaceId = randomToken(18);
  const rootId = randomToken(18);
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        "INSERT INTO users (id, username, display_name, status, created_at, updated_at) VALUES (?, ?, 'Telegram User', 'active', ?, ?)",
      ).bind(userId, username, created, created),
      c.env.DB.prepare(
        "INSERT INTO auth_identities (id, user_id, provider, issuer, subject, created_at, last_used_at) VALUES (?, ?, 'telegram', ?, ?, ?, ?)",
      ).bind(randomToken(18), userId, TELEGRAM_ISSUER, subject, created, created),
      c.env.DB.prepare(
        "INSERT INTO workspaces (id, owner_id, name, created_at, updated_at) VALUES (?, ?, 'My Drive', ?, ?)",
      ).bind(workspaceId, userId, created, created),
      c.env.DB.prepare(
        `INSERT INTO folders (id, workspace_id, parent_id, name, normalized_name, path_key, created_at, updated_at)
        VALUES (?, ?, NULL, 'My Drive', 'my drive', ?, ?, ?)`,
      ).bind(rootId, workspaceId, rootId, created, created),
      c.env.DB.prepare(
        "INSERT INTO audit_events (id, actor_id, action, target_type, target_id, created_at) VALUES (?, ?, 'telegram.registered', 'user', ?, ?)",
      ).bind(randomToken(18), userId, userId, created),
    ]);
    telegramOidcDiagnostic('identity_persistence', 'created');
  } catch (error) {
    if (isConstraintError(error)) {
      telegramOidcDiagnostic('identity_persistence', 'conflict');
      fail(409, 'TELEGRAM_IDENTITY_EXISTS', 'Telegram account is already registered');
    }
    telegramOidcDiagnostic('identity_persistence', 'failed', { errorClass: telegramErrorClass(error) });
    throw error;
  }
  try {
    await setSession(c, userId);
    telegramOidcDiagnostic('session_persistence', 'created');
  } catch (error) {
    telegramOidcDiagnostic('session_persistence', 'failed', { errorClass: telegramErrorClass(error) });
    throw error;
  }
  return telegramRedirect(c);
});

app.get('/v1/workspaces', async (c) => {
  const session = await requireSession(c);
  const workspaces = await accessibleWorkspaces(c, session.id);
  return c.json({
    workspaces: await Promise.all(
      workspaces.map(async (workspace) => ({
        id: workspace.id,
        name: workspace.name,
        ownerId: workspace.owner_id,
        isOwner: workspace.is_owner,
        members: await workspaceMembers(c, workspace),
      })),
    ),
  });
});

app.get('/v1/workspace', async (c) => {
  const session = await requireSession(c);
  const workspace = await workspaceForUser(c, session.id, optionalString(c.req.query('workspaceId'), 'workspaceId'));
  const root = await first<{ id: string; name: string }>(
    c.env.DB,
    'SELECT id, name FROM folders WHERE workspace_id = ? AND parent_id IS NULL AND deleted_at IS NULL',
    workspace.id,
  );
  if (!root) fail(500, 'ROOT_FOLDER_MISSING', 'Root folder is missing');
  return c.json({
    workspace: {
      id: workspace.id,
      name: workspace.name,
      ownerId: workspace.owner_id,
      isOwner: workspace.is_owner,
      members: await workspaceMembers(c, workspace),
    },
    rootFolder: root,
  });
});

app.get('/v1/workspaces/:id/members', async (c) => {
  const session = await requireSession(c);
  const workspace = await workspaceForUser(c, session.id, c.req.param('id'));
  requireWorkspaceOwner(workspace);
  return c.json({ workspaceId: workspace.id, members: await workspaceMembers(c, workspace) });
});

app.post('/v1/workspaces/:id/members', async (c) => {
  const session = await requireSession(c);
  const workspace = await workspaceForUser(c, session.id, c.req.param('id'));
  requireWorkspaceOwner(workspace);
  const body = record(await readJson<unknown>(c));
  const userId = stringValue(body.userId, 'userId', 128);
  if (body.workspaceId !== undefined && stringValue(body.workspaceId, 'workspaceId', 128) !== workspace.id)
    fail(422, 'WORKSPACE_MISMATCH', 'Workspace must be selected by route');
  if (userId === workspace.owner_id) fail(409, 'OWNER_CANNOT_BE_MEMBER', 'Workspace owner is already implicit');
  if (userId === session.id) fail(409, 'SELF_MEMBER_FORBIDDEN', 'Owner cannot add self as member');
  const target = await first<{ id: string; status: UserRow['status'] }>(
    c.env.DB,
    'SELECT id, status FROM users WHERE id = ?',
    userId,
  );
  if (!target || target.status !== 'active') fail(404, 'MEMBER_USER_NOT_FOUND', 'Active member user not found');
  const existing = await first<{ user_id: string }>(
    c.env.DB,
    'SELECT user_id FROM workspace_members WHERE workspace_id = ?',
    workspace.id,
  );
  if (existing) {
    if (existing.user_id === userId) fail(409, 'MEMBER_ALREADY_EXISTS', 'User is already a workspace member');
    fail(409, 'WORKSPACE_MEMBER_LIMIT', 'Workspace already has a member');
  }
  const timestamp = now();
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        'INSERT INTO workspace_members (workspace_id, user_id, created_by, created_at) VALUES (?, ?, ?, ?)',
      ).bind(workspace.id, userId, session.id, timestamp),
      audit(c.env.DB, session.id, 'workspace.member_added', 'user', userId),
    ]);
  } catch (error) {
    if (isConstraintError(error)) fail(409, 'WORKSPACE_MEMBER_LIMIT', 'Workspace already has a member');
    throw error;
  }
  return c.json({ workspaceId: workspace.id, member: { userId, role: 'member', createdAt: timestamp } });
});

app.delete('/v1/workspaces/:id/members/:userId', async (c) => {
  const session = await requireSession(c);
  const workspace = await workspaceForUser(c, session.id, c.req.param('id'));
  requireWorkspaceOwner(workspace);
  const userId = stringValue(c.req.param('userId'), 'userId', 128);
  if (userId === workspace.owner_id) fail(409, 'OWNER_CANNOT_BE_REMOVED', 'Workspace owner cannot be removed');
  const result = await c.env.DB.prepare(
    'DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?',
  )
    .bind(workspace.id, userId)
    .run();
  if (changes(result) !== 1) fail(404, 'MEMBER_NOT_FOUND', 'Workspace member not found');
  await audit(c.env.DB, session.id, 'workspace.member_removed', 'user', userId).run();
  return c.json({ workspaceId: workspace.id, userId, removed: true });
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
    WHERE (w.owner_id = ? OR EXISTS (
      SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = w.id AND wm.user_id = ?
    )) AND o.status = 'completed' AND o.deleted_at IS NULL
      AND (o.updated_at < ? OR (o.updated_at = ? AND (o.created_at < ? OR (o.created_at = ? AND o.id > ?))))
    ORDER BY o.updated_at DESC, o.created_at DESC, o.id ASC
    LIMIT ?
  `,
    session.id,
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
    workspace_id: string;
    name: string;
    mime: string | null;
    size: number | null;
    sha256: string | null;
    part_count: number | null;
    deleted_at: string;
    created_at: string;
    updated_at: string;
    sort_at: string;
    can_permanently_delete: number;
  }>(
    c.env.DB,
    `
    SELECT * FROM (
      SELECT 'folder' AS kind, f.id, f.parent_id, NULL AS folder_id, w.id AS workspace_id, f.name, NULL AS mime, NULL AS size,
             NULL AS sha256, NULL AS part_count, f.deleted_at, f.created_at, f.updated_at, f.deleted_at AS sort_at,
             CASE WHEN w.owner_id = ? THEN 1 ELSE 0 END AS can_permanently_delete
      FROM folders f JOIN workspaces w ON w.id = f.workspace_id
      WHERE (w.owner_id = ? OR EXISTS (
        SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = w.id AND wm.user_id = ?
      )) AND f.deleted_at IS NOT NULL
      UNION ALL
      SELECT 'object' AS kind, o.id, NULL AS parent_id, o.folder_id, w.id AS workspace_id, o.name, o.mime, o.size,
             o.sha256, o.part_count, o.deleted_at, o.created_at, o.updated_at, o.deleted_at AS sort_at,
             CASE WHEN w.owner_id = ? THEN 1 ELSE 0 END AS can_permanently_delete
      FROM objects o JOIN workspaces w ON w.id = o.workspace_id
      WHERE (w.owner_id = ? OR EXISTS (
        SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = w.id AND wm.user_id = ?
      )) AND o.status = 'deleted' AND o.deleted_at IS NOT NULL
    ) entries
    WHERE sort_at < ? OR (sort_at = ? AND (kind > ? OR (kind = ? AND id > ?)))
    ORDER BY sort_at DESC, kind ASC, id ASC
    LIMIT ?
  `,
    session.id,
    session.id,
    session.id,
    session.id,
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
          workspaceId: row.workspace_id,
          canPermanentlyDelete: row.can_permanently_delete === 1,
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
          workspaceId: row.workspace_id,
          canPermanentlyDelete: row.can_permanently_delete === 1,
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
  requireWorkspaceOwner(existing.workspace);
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
    const results = await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO objects (id, workspace_id, folder_id, name, normalized_name, mime, size, sha256, part_count, status, created_at, updated_at)
        SELECT ?, f.workspace_id, f.id, ?, ?, ?, ?, ?, ?, 'uploading', ?, ? FROM folders f
        JOIN workspaces w ON w.id = f.workspace_id
        WHERE f.id = ? AND f.workspace_id = ? AND f.deleted_at IS NULL
          AND (w.owner_id = ? OR EXISTS (
            SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = w.id AND wm.user_id = ?
          ))`,
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
        session.id,
        session.id,
      ),
      c.env.DB.prepare(
        `INSERT INTO upload_sessions (id, user_id, object_id, status, chunk_size, expected_part_count, idempotency_key, expires_at, created_at, updated_at)
        SELECT ?, ?, ?, 'created', ?, ?, ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM objects o JOIN workspaces w ON w.id = o.workspace_id
          WHERE o.id = ? AND (w.owner_id = ? OR EXISTS (
            SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = w.id AND wm.user_id = ?
          ))
        )`,
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
        objectId,
        session.id,
        session.id,
      ),
      c.env.DB.prepare(
        `INSERT INTO audit_events (id, actor_id, action, target_type, target_id, created_at)
        SELECT ?, ?, 'upload.started', 'object', ?, ? FROM objects o JOIN workspaces w ON w.id = o.workspace_id
        WHERE o.id = ? AND (w.owner_id = ? OR EXISTS (
          SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = w.id AND wm.user_id = ?
        ))`,
      ).bind(randomToken(18), session.id, objectId, timestamp, objectId, session.id, session.id),
    ]);
    if (results.some((result) => changes(result) !== 1)) fail(409, 'WORKSPACE_ACCESS_REVOKED', 'Workspace access changed; retry');
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
          JOIN workspaces w ON w.id = o.workspace_id
        WHERE us.id = ? AND us.user_id = ? AND us.status IN ('created', 'uploading', 'paused') AND us.expires_at > ?
          AND o.status = 'uploading' AND o.deleted_at IS NULL
          AND (w.owner_id = ? OR EXISTS (
            SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = w.id AND wm.user_id = ?
          ))`,
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
        session.id,
        timestamp,
        session.id,
        session.id,
      ),
      c.env.DB.prepare(
        `UPDATE upload_sessions SET status = 'uploading', updated_at = ?
        WHERE id = ? AND user_id = ? AND status IN ('created', 'uploading', 'paused') AND expires_at > ?
          AND EXISTS (
            SELECT 1 FROM objects o JOIN workspaces w ON w.id = o.workspace_id
            WHERE o.id = ? AND o.status = 'uploading' AND o.deleted_at IS NULL
              AND (w.owner_id = ? OR EXISTS (
                SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = w.id AND wm.user_id = ?
              ))
          )`,
      ).bind(timestamp, upload.id, session.id, timestamp, upload.object_id, session.id, session.id),
      c.env.DB.prepare(
        `INSERT INTO audit_events (id, actor_id, action, target_type, target_id, created_at)
        SELECT ?, ?, 'upload.part_committed', 'object', ?, ?
        FROM upload_sessions us JOIN objects o ON o.id = us.object_id JOIN workspaces w ON w.id = o.workspace_id
        WHERE us.id = ? AND us.user_id = ? AND o.status = 'uploading' AND o.deleted_at IS NULL
          AND (w.owner_id = ? OR EXISTS (
            SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = w.id AND wm.user_id = ?
          )) AND EXISTS (SELECT 1 FROM object_parts WHERE id = ?)`,
      ).bind(randomToken(18), session.id, upload.object_id, timestamp, upload.id, session.id, session.id, session.id, partId),
    ]);
    if (results.some((result) => changes(result) !== 1)) fail(409, 'UPLOAD_CLOSED', 'Upload session is closed');
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
      AND EXISTS (
        SELECT 1 FROM upload_sessions us JOIN workspaces w ON w.id = objects.workspace_id
        WHERE us.id = ? AND us.user_id = ? AND us.object_id = objects.id
          AND us.status IN ('created', 'uploading', 'paused', 'verifying') AND us.expires_at > ?
          AND (w.owner_id = ? OR EXISTS (
            SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = w.id AND wm.user_id = ?
          ))
      )`,
    ).bind(timestamp, upload.object_id, upload.id, session.id, timestamp, session.id, session.id),
    c.env.DB.prepare(
      `UPDATE upload_sessions SET status = 'completed', updated_at = ? WHERE id = ?
      AND user_id = ? AND status IN ('created', 'uploading', 'paused', 'verifying') AND expires_at > ?
      AND EXISTS (
        SELECT 1 FROM objects o JOIN workspaces w ON w.id = o.workspace_id
        WHERE o.id = ? AND o.status = 'completed'
          AND (w.owner_id = ? OR EXISTS (
            SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = w.id AND wm.user_id = ?
          ))
      )`,
    ).bind(timestamp, upload.id, session.id, timestamp, upload.object_id, session.id, session.id),
    c.env.DB.prepare(
      `INSERT INTO audit_events (id, actor_id, action, target_type, target_id, created_at)
      SELECT ?, ?, 'upload.completed', 'object', ?, ?
      FROM upload_sessions us JOIN objects o ON o.id = us.object_id JOIN workspaces w ON w.id = o.workspace_id
      WHERE us.id = ? AND us.user_id = ? AND us.object_id = ? AND o.status = 'completed' AND o.updated_at = ?
        AND (w.owner_id = ? OR EXISTS (
          SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = w.id AND wm.user_id = ?
        ))`,
    ).bind(randomToken(18), session.id, upload.object_id, timestamp, upload.id, session.id, upload.object_id, timestamp, session.id, session.id),
  ]);
  if (results.some((result) => changes(result) !== 1)) fail(409, 'UPLOAD_CLOSED', 'Upload session is closed');
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
      AND user_id = ? AND status IN ('created', 'uploading', 'paused', 'verifying', 'failed')
      AND EXISTS (
        SELECT 1 FROM objects o JOIN workspaces w ON w.id = o.workspace_id
        WHERE o.id = upload_sessions.object_id
          AND (w.owner_id = ? OR EXISTS (
            SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = w.id AND wm.user_id = ?
          ))
      )`,
    ).bind(timestamp, upload.id, session.id, session.id, session.id),
    c.env.DB.prepare(
      `UPDATE objects SET status = 'aborted', updated_at = ? WHERE id = ? AND status = 'uploading' AND deleted_at IS NULL
      AND EXISTS (
        SELECT 1 FROM upload_sessions us JOIN workspaces w ON w.id = objects.workspace_id
        WHERE us.id = ? AND us.user_id = ? AND us.status = 'aborted'
          AND (w.owner_id = ? OR EXISTS (
            SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = w.id AND wm.user_id = ?
          ))
      )`,
    ).bind(timestamp, upload.object_id, upload.id, session.id, session.id, session.id),
    c.env.DB.prepare(
      `INSERT INTO audit_events (id, actor_id, action, target_type, target_id, created_at)
      SELECT ?, ?, 'upload.aborted', 'object', ?, ?
      FROM upload_sessions us JOIN objects o ON o.id = us.object_id JOIN workspaces w ON w.id = o.workspace_id
      WHERE us.id = ? AND us.user_id = ? AND us.status = 'aborted'
        AND (w.owner_id = ? OR EXISTS (
          SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = w.id AND wm.user_id = ?
        ))`,
    ).bind(randomToken(18), session.id, upload.object_id, timestamp, upload.id, session.id, session.id, session.id),
  ]);
  if (results.some((result) => changes(result) !== 1)) fail(409, 'UPLOAD_CLOSED', 'Upload session is closed');
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
  if (!object.is_owner) fail(403, 'WORKSPACE_OWNER_REQUIRED', 'Workspace owner required');
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
  const workspace = await workspaceForUser(c, session.id, optionalString(c.req.query('workspaceId'), 'workspaceId'));
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

type TelegramBot = { id: string; token: string };
type TelegramPoolReasonCode =
  | 'READY'
  | 'CHANNEL_MISSING'
  | 'NO_VALID_BOTS'
  | 'GET_CHAT_TRANSPORT_FAILURE'
  | 'GET_CHAT_API_REJECTION'
  | 'INVALID_TELEGRAM_PAYLOAD';
type TelegramPoolReason = { code: TelegramPoolReasonCode; message: string };
type TelegramPool = { channelId: string; botCount: number; channel: string; reason: TelegramPoolReason };

const telegramPoolReasons: Record<TelegramPoolReasonCode, TelegramPoolReason> = {
  READY: { code: 'READY', message: 'Storage pool is ready' },
  CHANNEL_MISSING: { code: 'CHANNEL_MISSING', message: 'Shared Telegram channel is not configured' },
  NO_VALID_BOTS: { code: 'NO_VALID_BOTS', message: 'No valid Telegram bot tokens are configured' },
  GET_CHAT_TRANSPORT_FAILURE: { code: 'GET_CHAT_TRANSPORT_FAILURE', message: 'Telegram getChat transport failed' },
  GET_CHAT_API_REJECTION: { code: 'GET_CHAT_API_REJECTION', message: 'Telegram getChat API rejected the request' },
  INVALID_TELEGRAM_PAYLOAD: { code: 'INVALID_TELEGRAM_PAYLOAD', message: 'Telegram getChat response was invalid' },
};

export function poolBotIndex(key: string, botCount: number): number {
  if (botCount < 1) return 0;
  let hash = 2166136261;
  for (let index = 0; index < key.length; index += 1) hash = Math.imul(hash ^ key.charCodeAt(index), 16777619);
  return (hash >>> 0) % botCount;
}

function telegramBots(env: Bindings): TelegramBot[] {
  return (env.TELEGRAM_BOT_TOKENS ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const separator = entry.indexOf(':');
      return separator > 0 ? { id: entry.slice(0, separator), token: entry } : null;
    })
    .filter((bot): bot is TelegramBot => Boolean(bot?.id && bot.token));
}

function telegramPayloadRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function telegramDescription(value: unknown, token: string): string | undefined {
  if (typeof value !== 'string') return undefined;
  const secret = token.slice(token.indexOf(':') + 1);
  const sanitized = value
    .replaceAll(token, '[redacted]')
    .replaceAll(secret, '[redacted]')
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!sanitized) return undefined;
  return sanitized.length > 256 ? `${sanitized.slice(0, 253)}...` : sanitized;
}

function telegramApiRejection(status: number, description: unknown, token: string): TelegramPoolReason {
  const safeDescription = telegramDescription(description, token);
  return {
    code: 'GET_CHAT_API_REJECTION',
    message: `Telegram getChat API rejected the request (HTTP ${status})${safeDescription ? `: ${safeDescription}` : ''}`,
  };
}

async function telegramCall(token: string, method: string, body?: BodyInit, headers?: HeadersInit): Promise<Response> {
  const init: RequestInit & { cf?: { httpProtocol: 'http1' } } = {
    method: body ? 'POST' : 'GET',
    body,
    headers: {
      'User-Agent': 'curl/8.4.0',
      ...headers,
    },
    cf: { httpProtocol: 'http1' },
  };
  return fetch(`https://api.telegram.org/bot${token}/${method}`, init);
}

async function telegramPool(c: Context<AppEnv>): Promise<TelegramPool> {
  const channel = (c.env.TELEGRAM_SHARED_CHANNEL ?? '').trim();
  const bots = telegramBots(c.env);
  if (!channel)
    return {
      channelId: '',
      botCount: bots.length,
      channel: '',
      reason: telegramPoolReasons.CHANNEL_MISSING,
    };
  if (bots.length === 0)
    return {
      channelId: '',
      botCount: 0,
      channel: '',
      reason: telegramPoolReasons.NO_VALID_BOTS,
    };
  const cached = await first<{ channel_id: string; bot_count: number }>(
    c.env.DB,
    'SELECT channel_id, bot_count FROM telegram_pool WHERE id = 1',
  );
  if (cached && cached.bot_count === bots.length && typeof cached.channel_id === 'string' && cached.channel_id)
    return { channelId: cached.channel_id, botCount: bots.length, channel, reason: telegramPoolReasons.READY };
  let response: Response;
  try {
    response = await telegramCall(bots[0].token, 'getChat', JSON.stringify({ chat_id: channel }), {
      'Content-Type': 'application/json',
    });
  } catch (error) {
    // ponytail: temporary safe local diagnostic; remove after env mismatch is resolved.
    console.info('telegram pool getChat', {
      botId: bots[0].id,
      tokenLength: bots[0].token.length,
      tokenFingerprint: (await sha256(bots[0].token)).slice(0, 12),
      channel,
      telegramStatus: null,
      telegramDescription: error instanceof Error ? error.name : 'Unknown error',
    });
    return { channelId: '', botCount: bots.length, channel, reason: telegramPoolReasons.GET_CHAT_TRANSPORT_FAILURE };
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    console.info('telegram pool getChat', {
      botId: bots[0].id,
      tokenLength: bots[0].token.length,
      tokenFingerprint: (await sha256(bots[0].token)).slice(0, 12),
      channel,
      telegramStatus: response.status,
      telegramDescription: 'Invalid JSON response',
    });
    if (!response.ok)
      return {
        channelId: '',
        botCount: bots.length,
        channel,
        reason: telegramApiRejection(response.status, undefined, bots[0].token),
      };
    return { channelId: '', botCount: bots.length, channel, reason: telegramPoolReasons.INVALID_TELEGRAM_PAYLOAD };
  }
  const payloadRecord = telegramPayloadRecord(payload);
  // ponytail: temporary safe local diagnostic; remove after env mismatch is resolved.
  let getMeStatus: number | null = null;
  try {
    getMeStatus = (await telegramCall(bots[0].token, 'getMe', undefined)).status;
  } catch {
    getMeStatus = null;
  }
  console.info('telegram pool getChat', {
    botId: bots[0].id,
    tokenLength: bots[0].token.length,
    tokenFingerprint: (await sha256(bots[0].token)).slice(0, 12),
    channel,
    telegramStatus: response.status,
    telegramDescription: telegramDescription(payloadRecord?.description, bots[0].token) ?? null,
    getMeStatus,
    telegramHeaders: {
      server: response.headers.get('server'),
      cfRay: response.headers.get('cf-ray'),
      contentType: response.headers.get('content-type'),
    },
  });
  if (!response.ok || payloadRecord?.ok === false)
    return {
      channelId: '',
      botCount: bots.length,
      channel,
      reason: telegramApiRejection(response.status, payloadRecord?.description, bots[0].token),
    };
  const result = telegramPayloadRecord(payloadRecord?.result);
  const rawChannelId = result?.id;
  const channelId =
    typeof rawChannelId === 'string' && rawChannelId.length > 0
      ? rawChannelId
      : typeof rawChannelId === 'number' && Number.isSafeInteger(rawChannelId)
        ? String(rawChannelId)
        : '';
  if (payloadRecord?.ok !== true || !channelId)
    return { channelId: '', botCount: bots.length, channel, reason: telegramPoolReasons.INVALID_TELEGRAM_PAYLOAD };
  await c.env.DB.prepare(
    `INSERT INTO telegram_pool (id, channel_id, bot_count, verified_at) VALUES (1, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET channel_id = excluded.channel_id, bot_count = excluded.bot_count, verified_at = excluded.verified_at`,
  )
    .bind(channelId, bots.length, now())
    .run();
  return { channelId, botCount: bots.length, channel, reason: telegramPoolReasons.READY };
}

function botAttemptResponse(attempt: Record<string, unknown>, partNo: number) {
  return { partNo, status: botAttemptStatus(attempt.state), idempotencyKey: attempt.idempotency_key ?? null };
}

function botAttemptStatus(state: unknown): string {
  switch (state) {
    case 'ambiguous':
      return 'ambiguous';
    case 'committed':
      return 'committed';
    case 'abandoned':
      return 'abandoned';
    case 'reserved':
    case 'sending':
    case 'sent':
      return 'in_progress';
    default:
      return 'not_started';
  }
}

app.get('/v1/telegram/pool', async (c) => {
  const pool = await telegramPool(c);
  return c.json({
    channel: pool.channel,
    botCount: pool.botCount,
    ready: Boolean(pool.channelId),
    reason: pool.reason,
  });
});

app.post('/v1/bot/uploads', async (c) => {
  const session = await requireSession(c);
  const body = metadataOnly(record(await readJson<unknown>(c)));
  const { name, normalized } = normalizedName(body.name);
  const maxBotUploadBytes = 5 * 1024 * 1024 * 1024;
  if (typeof body.size === 'number' && body.size > maxBotUploadBytes)
    fail(413, 'UPLOAD_TOO_LARGE', 'Upload exceeds the maximum supported size');
  const size = integerValue(body.size, 'size', 0, maxBotUploadBytes);
  const mime = stringValue(body.mime ?? 'application/octet-stream', 'mime', 128);
  const chunkSize = integerValue(body.chunkSize ?? 16 * 1024 * 1024, 'chunkSize', MIN_CHUNK_SIZE, MAX_CHUNK_SIZE);
  const partCount = integerValue(body.partCount, 'partCount', 0, MAX_PARTS);
  if (partCount !== (size === 0 ? 0 : Math.ceil(size / chunkSize)))
    fail(422, 'PART_COUNT_MISMATCH', 'partCount does not match size and chunkSize');
  const sha256Value = hashValue(body.sha256, 'sha256');
  const idempotencyKey = stringValue(body.idempotencyKey, 'idempotencyKey', 200);
  const { workspace, folder } = await folderForUser(c, session.id, optionalString(body.folderId, 'folderId'));
  const objectId = randomToken(18);
  const uploadId = randomToken(18);
  const timestamp = now();
  const expires = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
  const results = await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO objects (id, workspace_id, folder_id, name, normalized_name, mime, size, sha256, part_count, status, storage_backend, created_at, updated_at)
      SELECT ?, f.workspace_id, f.id, ?, ?, ?, ?, ?, ?, 'uploading', 'bot_api', ?, ? FROM folders f JOIN workspaces w ON w.id = f.workspace_id
      WHERE f.id = ? AND f.workspace_id = ? AND f.deleted_at IS NULL
        AND (w.owner_id = ? OR EXISTS (
          SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = w.id AND wm.user_id = ?
        ))`,
    ).bind(
      objectId,
      name,
      normalized,
      mime,
      size,
      sha256Value,
      partCount,
      timestamp,
      timestamp,
      folder.id,
      workspace.id,
      session.id,
      session.id,
    ),
    c.env.DB.prepare(
      `INSERT INTO upload_sessions (id, user_id, object_id, status, chunk_size, expected_part_count, idempotency_key, expires_at, created_at, updated_at)
      SELECT ?, ?, ?, 'created', ?, ?, ?, ?, ?, ? WHERE EXISTS (
        SELECT 1 FROM objects o JOIN workspaces w ON w.id = o.workspace_id
        WHERE o.id = ? AND (w.owner_id = ? OR EXISTS (
          SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = w.id AND wm.user_id = ?
        ))
      )`,
    ).bind(uploadId, session.id, objectId, chunkSize, partCount, idempotencyKey, expires, timestamp, timestamp, objectId, session.id, session.id),
    c.env.DB.prepare(
      `INSERT INTO audit_events (id, actor_id, action, target_type, target_id, created_at)
      SELECT ?, ?, 'upload.started', 'object', ?, ? FROM objects o JOIN workspaces w ON w.id = o.workspace_id
      WHERE o.id = ? AND (w.owner_id = ? OR EXISTS (
        SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = w.id AND wm.user_id = ?
      ))`,
    ).bind(randomToken(18), session.id, objectId, timestamp, objectId, session.id, session.id),
  ]);
  if (results.some((result) => changes(result) !== 1)) fail(409, 'WORKSPACE_ACCESS_REVOKED', 'Workspace access changed; retry');
  const createdObject = await first<{ id: string }>(c.env.DB, 'SELECT o.id FROM objects o WHERE o.id = ?', objectId);
  return c.json({
    id: uploadId,
    objectId: createdObject?.id ?? objectId,
    status: 'created',
    chunkSize,
    expectedPartCount: partCount,
    expiresAt: expires,
    parts: [],
  });
});

app.put('/v1/bot/uploads/:id/parts/:no', async (c) => {
  const session = await requireSession(c);
  const upload = await uploadForUser(c, session.id, c.req.param('id'));
  const partNo = integerValue(Number(c.req.param('no')), 'partNo', 0, Math.max(0, upload.expected_part_count - 1));
  if (upload.expected_part_count === 0) fail(409, 'NO_PARTS_EXPECTED', 'Empty upload has no parts');
  const size = integerValue(Number(c.req.header('X-Part-Size')), 'partSize', 1, MAX_CHUNK_SIZE);
  const sha256Value = hashValue(c.req.header('X-Part-SHA256'), 'partSha256');
  const idempotencyKey = stringValue(c.req.header('X-Idempotency-Key'), 'idempotencyKey', 200);
  const expectedSize =
    partNo === upload.expected_part_count - 1
      ? upload.object_size - upload.chunk_size * (upload.expected_part_count - 1)
      : upload.chunk_size;
  if (size !== expectedSize) fail(422, 'PART_SIZE_MISMATCH', 'Part size does not match upload manifest');
  const pool = await telegramPool(c);
  if (!pool.channelId || pool.botCount === 0) fail(409, 'TELEGRAM_POOL_NOT_READY', 'Telegram bot pool is not ready');
  const botIndex = poolBotIndex(idempotencyKey, pool.botCount);
  const existingPart = await first<PartRow>(
    c.env.DB,
    'SELECT id, object_id, part_no, size, sha256, message_id, bot_file_id, idempotency_key, created_at, bot_index FROM object_parts WHERE object_id = ? AND part_no = ?',
    upload.object_id,
    partNo,
  );
  if (existingPart) {
    if (
      existingPart.size !== size ||
      existingPart.sha256 !== sha256Value ||
      existingPart.idempotency_key !== idempotencyKey
    )
      fail(409, 'PART_IDEMPOTENCY_CONFLICT', 'Part already committed with different metadata');
    return c.json(partResponse(existingPart));
  }
  const existingAttempt = await first<Record<string, unknown>>(
    c.env.DB,
    'SELECT * FROM bot_part_attempts WHERE upload_session_id = ? AND part_no = ?',
    upload.id,
    partNo,
  );
  if (existingAttempt && existingAttempt.idempotency_key !== idempotencyKey && existingAttempt.state !== 'abandoned')
    fail(409, 'PART_IDEMPOTENCY_CONFLICT', 'Part already has another attempt');
  if (existingAttempt?.state === 'abandoned') {
    await c.env.DB.prepare(
      `UPDATE bot_part_attempts SET state = 'reserved', idempotency_key = ?, expected_size = ?, expected_sha256 = ?, reserved_at = ?, bot_index = ?, updated_at = ?
      WHERE id = ? AND state = 'abandoned' AND EXISTS (
        SELECT 1 FROM upload_sessions us JOIN objects o ON o.id = us.object_id JOIN workspaces w ON w.id = o.workspace_id
        WHERE us.id = bot_part_attempts.upload_session_id AND us.user_id = ?
          AND (w.owner_id = ? OR EXISTS (
            SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = w.id AND wm.user_id = ?
          ))
      )`,
    )
      .bind(idempotencyKey, size, sha256Value, now(), botIndex, now(), existingAttempt.id, session.id, session.id, session.id)
      .run();
    existingAttempt.idempotency_key = idempotencyKey;
    existingAttempt.state = 'reserved';
  }
  if (existingAttempt && ['ambiguous', 'sending'].includes(String(existingAttempt.state))) {
    if (
      existingAttempt.state === 'sending' &&
      existingAttempt.sending_lease_until &&
      Date.parse(String(existingAttempt.sending_lease_until)) <= Date.now()
    ) {
      await c.env.DB.prepare(
        `UPDATE bot_part_attempts SET state = 'ambiguous', ambiguous_at = ?, sending_lease_until = NULL, updated_at = ?
        WHERE id = ? AND state = 'sending' AND send_generation = ? AND sending_lease_until <= ? AND EXISTS (
          SELECT 1 FROM upload_sessions us JOIN objects o ON o.id = us.object_id JOIN workspaces w ON w.id = o.workspace_id
          WHERE us.id = bot_part_attempts.upload_session_id AND us.user_id = ?
            AND (w.owner_id = ? OR EXISTS (
              SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = w.id AND wm.user_id = ?
            ))
        )`,
      )
        .bind(now(), now(), existingAttempt.id, existingAttempt.send_generation, now(), session.id, session.id, session.id)
        .run();
    } else fail(409, 'PART_ATTEMPT_IN_PROGRESS', 'Part attempt requires explicit resolution');
  }
  const attemptId = String(existingAttempt?.id ?? randomToken(18));
  const timestamp = now();
  if (!existingAttempt) {
    const reserved = await c.env.DB.prepare(
      `INSERT INTO bot_part_attempts (id, upload_session_id, part_no, idempotency_key, expected_size, expected_sha256, state, reserved_at, created_at, updated_at, bot_index)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM upload_sessions us JOIN objects o ON o.id = us.object_id JOIN workspaces w ON w.id = o.workspace_id
        WHERE us.id = ? AND us.user_id = ? AND o.status = 'uploading' AND o.deleted_at IS NULL
          AND (w.owner_id = ? OR EXISTS (
            SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = w.id AND wm.user_id = ?
          ))
      )`,
    )
      .bind(
        attemptId,
        upload.id,
        partNo,
        idempotencyKey,
        size,
        sha256Value,
        'reserved',
        timestamp,
        timestamp,
        timestamp,
        botIndex,
        upload.id,
        session.id,
        session.id,
        session.id,
      )
      .run();
    if (changes(reserved) !== 1) fail(409, 'WORKSPACE_ACCESS_REVOKED', 'Workspace access changed; retry');
  }
  const generation = randomToken(18);
  // Lease must cover upstream browser upload, worker forward, and part hashing.
  // Conservative floor of ~100 KB/s upstream: 16 MiB part can take minutes on a slow link.
  const lease = new Date(Date.now() + Math.max(60_000, Math.ceil(size / 100_000) * 1000 + 60_000)).toISOString();
  const claimed = await c.env.DB.prepare(
    `UPDATE bot_part_attempts SET state = 'sending', sending_at = ?, send_generation = ?, sending_lease_until = ?, updated_at = ?
    WHERE id = ? AND state = 'reserved' AND EXISTS (
      SELECT 1 FROM upload_sessions us JOIN objects o ON o.id = us.object_id JOIN workspaces w ON w.id = o.workspace_id
      WHERE us.id = bot_part_attempts.upload_session_id AND us.user_id = ? AND o.status = 'uploading' AND o.deleted_at IS NULL
        AND (w.owner_id = ? OR EXISTS (
          SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = w.id AND wm.user_id = ?
        ))
    )`,
  )
    .bind(timestamp, generation, lease, timestamp, attemptId, session.id, session.id, session.id)
    .run();
  if (changes(claimed) !== 1) fail(409, 'PART_ATTEMPT_IN_PROGRESS', 'Part attempt is already being sent');
  const bot = telegramBots(c.env)[botIndex];
  const boundary = `----teledrive-${randomToken(12)}`;
  const { stream, state } = createMultipartStream(
    c.req.raw.body ?? new ReadableStream(),
    boundary,
    pool.channelId,
    upload.object_name,
    upload.mime,
    size,
    sha256Value,
    c.req.raw.signal,
  );
  let response: Response;
  try {
    response = await telegramCall(bot.token, 'sendDocument', stream, {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    });
    if (!state.completed) throw new StreamingBodyError('Stream did not complete');
  } catch (error) {
    await c.env.DB.prepare(
      `UPDATE bot_part_attempts SET state = 'ambiguous', ambiguous_at = ?, sending_lease_until = NULL, updated_at = ?
      WHERE id = ? AND state = 'sending' AND send_generation = ? AND EXISTS (
        SELECT 1 FROM upload_sessions us JOIN objects o ON o.id = us.object_id JOIN workspaces w ON w.id = o.workspace_id
        WHERE us.id = bot_part_attempts.upload_session_id AND us.user_id = ?
          AND (w.owner_id = ? OR EXISTS (
            SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = w.id AND wm.user_id = ?
          ))
      )`,
    )
      .bind(now(), now(), attemptId, generation, session.id, session.id, session.id)
      .run();
    if (error instanceof StreamingBodyError) fail(422, 'PART_STREAM_INVALID', error.message);
    fail(502, 'TELEGRAM_TRANSPORT_ERROR', 'Telegram transport failed');
  }
  if (response.status === 429) {
    await c.env.DB.prepare(
      `UPDATE bot_part_attempts SET state = 'abandoned', abandoned_at = ?, send_generation = NULL, updated_at = ?
      WHERE id = ? AND send_generation = ? AND EXISTS (
        SELECT 1 FROM upload_sessions us JOIN objects o ON o.id = us.object_id JOIN workspaces w ON w.id = o.workspace_id
        WHERE us.id = bot_part_attempts.upload_session_id AND us.user_id = ?
          AND (w.owner_id = ? OR EXISTS (
            SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = w.id AND wm.user_id = ?
          ))
      )`,
    )
      .bind(now(), now(), attemptId, generation, session.id, session.id, session.id)
      .run();
    const retryAfter = response.headers.get('Retry-After');
    if (retryAfter) c.header('Retry-After', retryAfter);
    c.header('Access-Control-Expose-Headers', 'Retry-After');
    fail(429, 'TELEGRAM_RATE_LIMITED', 'Telegram rate limit reached');
  }
  if (!response.ok) {
    await c.env.DB.prepare(
      `UPDATE bot_part_attempts SET state = 'abandoned', abandoned_at = ?, send_generation = NULL, updated_at = ?
      WHERE id = ? AND send_generation = ? AND EXISTS (
        SELECT 1 FROM upload_sessions us JOIN objects o ON o.id = us.object_id JOIN workspaces w ON w.id = o.workspace_id
        WHERE us.id = bot_part_attempts.upload_session_id AND us.user_id = ?
          AND (w.owner_id = ? OR EXISTS (
            SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = w.id AND wm.user_id = ?
          ))
      )`,
    )
      .bind(now(), now(), attemptId, generation, session.id, session.id, session.id)
      .run();
    fail(502, 'TELEGRAM_ERROR', 'Telegram upload failed');
  }
  const payload = (await response.json()) as {
    ok?: boolean;
    result?: { message_id?: string | number; document?: { file_id?: string } };
  };
  const messageId = String(payload.result?.message_id ?? '');
  const fileId = payload.result?.document?.file_id ?? '';
  if (!payload.ok || !messageId || !fileId) fail(502, 'TELEGRAM_ERROR', 'Telegram upload response invalid');
  const sent = await c.env.DB.prepare(
    `UPDATE bot_part_attempts SET state = 'sent', telegram_message_id = ?, telegram_file_id = ?, sent_at = ?, sending_lease_until = NULL, updated_at = ?
    WHERE id = ? AND state = 'sending' AND send_generation = ? AND sending_lease_until > ? AND EXISTS (
      SELECT 1 FROM upload_sessions us JOIN objects o ON o.id = us.object_id JOIN workspaces w ON w.id = o.workspace_id
      WHERE us.id = bot_part_attempts.upload_session_id AND us.user_id = ? AND o.status = 'uploading' AND o.deleted_at IS NULL
        AND (w.owner_id = ? OR EXISTS (
          SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = w.id AND wm.user_id = ?
        ))
    )`,
  )
    .bind(messageId, fileId, now(), now(), attemptId, generation, now(), session.id, session.id, session.id)
    .run();
  if (changes(sent) !== 1) fail(409, 'PART_ATTEMPT_STALE', 'Part attempt was superseded');
  const partId = randomToken(18);
  const committed = await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO object_parts (id, object_id, part_no, size, sha256, message_id, bot_file_id, idempotency_key, created_at, bot_index)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM upload_sessions us JOIN objects o ON o.id = us.object_id JOIN workspaces w ON w.id = o.workspace_id
        WHERE us.id = ? AND us.user_id = ? AND us.object_id = ? AND o.status = 'uploading' AND o.deleted_at IS NULL
          AND (w.owner_id = ? OR EXISTS (
            SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = w.id AND wm.user_id = ?
          ))
      ) AND EXISTS (
        SELECT 1 FROM bot_part_attempts ba WHERE ba.id = ? AND ba.state = 'sent' AND ba.send_generation = ?
      )`,
    ).bind(partId, upload.object_id, partNo, size, sha256Value, messageId, fileId, idempotencyKey, now(), botIndex, upload.id, session.id, upload.object_id, session.id, session.id, attemptId, generation),
    c.env.DB.prepare(
      `UPDATE bot_part_attempts SET state = 'committed', committed_at = ?, updated_at = ? WHERE id = ? AND state = 'sent' AND send_generation = ?
      AND EXISTS (SELECT 1 FROM object_parts WHERE id = ?)
      AND EXISTS (
        SELECT 1 FROM upload_sessions us JOIN objects o ON o.id = us.object_id JOIN workspaces w ON w.id = o.workspace_id
        WHERE us.id = bot_part_attempts.upload_session_id AND us.user_id = ? AND o.status = 'uploading' AND o.deleted_at IS NULL
          AND (w.owner_id = ? OR EXISTS (
            SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = w.id AND wm.user_id = ?
          ))
      )`,
    ).bind(now(), now(), attemptId, generation, partId, session.id, session.id, session.id),
    c.env.DB.prepare(
      `INSERT INTO audit_events (id, actor_id, action, target_type, target_id, created_at)
      SELECT ?, ?, 'upload.part_committed', 'object', ?, ?
      FROM upload_sessions us JOIN objects o ON o.id = us.object_id JOIN workspaces w ON w.id = o.workspace_id
      WHERE us.id = ? AND us.user_id = ? AND us.object_id = ? AND o.status = 'uploading' AND o.deleted_at IS NULL
        AND (w.owner_id = ? OR EXISTS (
          SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = w.id AND wm.user_id = ?
        )) AND EXISTS (SELECT 1 FROM object_parts WHERE id = ?)
        AND EXISTS (SELECT 1 FROM bot_part_attempts ba WHERE ba.id = ? AND ba.state = 'committed' AND ba.send_generation = ?)`,
    ).bind(randomToken(18), session.id, upload.object_id, now(), upload.id, session.id, upload.object_id, session.id, session.id, partId, attemptId, generation),
  ]);
  if (committed.some((result) => changes(result) !== 1)) fail(409, 'PART_ATTEMPT_STALE', 'Part attempt was superseded');
  return c.json({
    id: partId,
    partNo,
    size,
    sha256: sha256Value,
    messageId,
    botFileId: fileId,
    idempotencyKey,
    createdAt: now(),
  });
});

app.get('/v1/bot/uploads/:id/parts/:no/attempt', async (c) => {
  const session = await requireSession(c);
  const upload = await uploadForUser(c, session.id, c.req.param('id'));
  const partNo = integerValue(Number(c.req.param('no')), 'partNo', 0, MAX_PARTS);
  let attempt = await first<Record<string, unknown>>(
    c.env.DB,
    'SELECT * FROM bot_part_attempts WHERE upload_session_id = ? AND part_no = ?',
    upload.id,
    partNo,
  );
  if (
    attempt?.state === 'sending' &&
    attempt.sending_lease_until &&
    Date.parse(String(attempt.sending_lease_until)) <= Date.now()
  ) {
    await c.env.DB.prepare(
      `UPDATE bot_part_attempts SET state = 'ambiguous', ambiguous_at = ?, sending_lease_until = NULL, updated_at = ? WHERE id = ? AND state = 'sending' AND send_generation = ? AND sending_lease_until <= ?`,
    )
      .bind(now(), now(), attempt.id, attempt.send_generation, now())
      .run();
    attempt = await first<Record<string, unknown>>(
      c.env.DB,
      'SELECT * FROM bot_part_attempts WHERE upload_session_id = ? AND part_no = ?',
      upload.id,
      partNo,
    );
  }
  if (!attempt) return c.json({ partNo, status: 'not_started' });
  return c.json(botAttemptResponse(attempt, partNo));
});

app.post('/v1/bot/uploads/:id/parts/:no/attempt/abandon', async (c) => {
  const session = await requireSession(c);
  const upload = await uploadForUser(c, session.id, c.req.param('id'));
  const partNo = integerValue(Number(c.req.param('no')), 'partNo', 0, MAX_PARTS);
  const attempt = await first<Record<string, unknown>>(
    c.env.DB,
    'SELECT * FROM bot_part_attempts WHERE upload_session_id = ? AND part_no = ?',
    upload.id,
    partNo,
  );
  if (!attempt) fail(404, 'PART_ATTEMPT_NOT_FOUND', 'Part attempt not found');
  const result = await c.env.DB.prepare(
    `UPDATE bot_part_attempts SET state = 'abandoned', abandoned_at = ?, send_generation = NULL, updated_at = ? WHERE id = ? AND send_generation = ? AND state IN ('ambiguous', 'reserved', 'sent')`,
  )
    .bind(now(), now(), attempt.id, attempt.send_generation)
    .run();
  if (changes(result) !== 1) fail(409, 'PART_ATTEMPT_IN_PROGRESS', 'Part attempt cannot be abandoned');
  return c.json({ partNo, status: 'abandoned' });
});

app.get('/v1/bot/objects/:id/manifest', async (c) => {
  const session = await requireSession(c);
  const object = await objectForUser(c, session.id, c.req.param('id'));
  const parts = await all<PartRow>(
    c.env.DB,
    'SELECT id, object_id, part_no, size, sha256, message_id, bot_file_id, idempotency_key, created_at, bot_index FROM object_parts WHERE object_id = ? ORDER BY part_no ASC',
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
      createdAt: object.created_at,
      updatedAt: object.updated_at,
    },
    parts: parts.map((part) => ({ partNo: part.part_no, size: part.size, sha256: part.sha256 })),
  });
});

app.get('/v1/bot/objects/:id/parts/:no/content', async (c) => {
  const session = await requireSession(c);
  const object = await objectForUser(c, session.id, c.req.param('id'));
  const partNo = integerValue(Number(c.req.param('no')), 'partNo', 0, MAX_PARTS);
  const part = await first<PartRow>(
    c.env.DB,
    'SELECT id, object_id, part_no, size, sha256, message_id, bot_file_id, idempotency_key, created_at, bot_index FROM object_parts WHERE object_id = ? AND part_no = ?',
    object.id,
    partNo,
  );
  if (!part?.bot_file_id) fail(404, 'PART_NOT_FOUND', 'Part not found');
  const bots = telegramBots(c.env);
  const bot = bots[part.bot_index ?? 0];
  const fileResponse = await telegramCall(bot.token, 'getFile', JSON.stringify({ file_id: part.bot_file_id }), {
    'Content-Type': 'application/json',
  });
  if (!fileResponse.ok) fail(502, 'TELEGRAM_ERROR', 'Telegram file lookup failed');
  const file = (await fileResponse.json()) as { ok?: boolean; result?: { file_path?: string } };
  if (!file.ok || !file.result?.file_path) fail(502, 'TELEGRAM_ERROR', 'Telegram file lookup failed');
  const content = await fetch(`https://api.telegram.org/file/bot${bot.token}/${file.result.file_path}`);
  if (!content.ok || !content.body) fail(502, 'TELEGRAM_ERROR', 'Telegram file download failed');
  return new Response(content.body, {
    status: 200,
    headers: { 'Content-Type': object.mime, 'Cache-Control': 'no-store' },
  });
});

/* Legacy per-user Telegram onboarding was removed; configuration belongs in Worker env. */
app.all('/v1/telegram/link', (c) => c.notFound());
app.all('/v1/webhooks/telegram', (c) => c.notFound());
app.all('/v1/telegram/bot', (c) => c.notFound());
app.all('/v1/telegram/bot/*', (c) => c.notFound());

/*
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
*/

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
