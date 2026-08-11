import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import app from '../src/index';
import { secretHash } from '../src/security';
import type { Bindings, D1Database, D1PreparedStatement, D1Result } from '../src/types';

const SECRET = 'workspace-acl-session-secret';
const USERS = { owner: 'owner-1', member: 'member-1', outsider: 'outsider-1' } as const;
const SESSIONS = { owner: 'owner-session', member: 'member-session', outsider: 'outsider-session' } as const;
const HASH = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

type DigestStreamConstructor = new (algorithm: string) => WritableStream<Uint8Array> & {
  digest: Promise<ArrayBuffer>;
};

class TestDigestStream extends WritableStream<Uint8Array> {
  readonly digest: Promise<ArrayBuffer>;

  constructor(algorithm: string) {
    if (algorithm !== 'SHA-256') throw new Error(`Unsupported digest algorithm: ${algorithm}`);
    const chunks: Uint8Array[] = [];
    let resolveDigest!: (digest: ArrayBuffer) => void;
    let rejectDigest!: (reason?: unknown) => void;
    const digest = new Promise<ArrayBuffer>((resolve, reject) => {
      resolveDigest = resolve;
      rejectDigest = reject;
    });
    super({
      write(chunk) {
        chunks.push(new Uint8Array(chunk));
      },
      async close() {
        try {
          const bytes = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0));
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
          }
          resolveDigest(await globalThis.crypto.subtle.digest('SHA-256', bytes));
        } catch (error) {
          rejectDigest(error);
          throw error;
        }
      },
      abort: rejectDigest,
    });
    this.digest = digest;
  }
}

const cryptoWithDigestStream = globalThis.crypto as typeof globalThis.crypto & { DigestStream?: DigestStreamConstructor };
const originalDigestStream = cryptoWithDigestStream.DigestStream;

beforeAll(() => {
  cryptoWithDigestStream.DigestStream = TestDigestStream;
});

afterAll(() => {
  if (originalDigestStream) cryptoWithDigestStream.DigestStream = originalDigestStream;
  else delete cryptoWithDigestStream.DigestStream;
});

type Fixture = { db: DatabaseSync; env: Bindings; hooks: { beforeBatch?: () => void } };

function d1(db: DatabaseSync, hooks: { beforeBatch?: () => void }): D1Database {
  return {
    prepare(query: string) {
      let values: unknown[] = [];
      const statement = {
        query,
        values,
        bind(...bound: unknown[]) {
          values = bound;
          statement.values = bound;
          return statement;
        },
        async first<T>() {
          return (db.prepare(query).get(...(values as never[])) as T | undefined) ?? null;
        },
        async all<T>() {
          return { results: db.prepare(query).all(...(values as never[])) as T[], success: true };
        },
        async run(): Promise<D1Result> {
          const result = db.prepare(query).run(...(values as never[]));
          return { success: true, meta: { changes: Number(result.changes) } };
        },
      } as unknown as D1PreparedStatement & { query: string; values: unknown[] };
      return statement;
    },
    async batch(statements) {
      hooks.beforeBatch?.();
      hooks.beforeBatch = undefined;
      return statements.map((statement) => {
        const bound = statement as D1PreparedStatement & { query?: string; values?: unknown[] };
        const result = db.prepare(bound.query ?? '').run(...((bound.values ?? []) as never[]));
        return { success: true, meta: { changes: Number(result.changes) } };
      });
    },
  };
}

async function fixture(): Promise<Fixture> {
  const db = new DatabaseSync(':memory:');
  const hooks: { beforeBatch?: () => void } = {};
  for (const name of [
    '0001_metadata.sql',
    '0002_oracle_audit_fixes.sql',
    '0003_multiuser_google_bot.sql',
    '0004_bot_transfer.sql',
    '0005_bot_part_attempts.sql',
    '0006_bot_part_attempt_leases.sql',
    '0007_bot_part_attempt_generations.sql',
    '0009_shared_bot_pool.sql',
    '0010_google_oauth_register_mode.sql',
    '0011_telegram_oidc_provider.sql',
    '0012_workspace_members.sql',
  ]) {
    db.exec(await readFile(new URL(`../../../migrations/${name}`, import.meta.url), 'utf8'));
  }
  db.exec(`
    INSERT INTO users (id, username, display_name, status, created_at, updated_at) VALUES
      ('${USERS.owner}', 'owner', 'Owner', 'active', '2026-01-01', '2026-01-01'),
      ('${USERS.member}', 'member', 'Member', 'active', '2026-01-01', '2026-01-01'),
      ('${USERS.outsider}', 'outsider', 'Outsider', 'active', '2026-01-01', '2026-01-01');
    INSERT INTO workspaces (id, owner_id, name, created_at, updated_at) VALUES
      ('workspace-1', '${USERS.owner}', 'Workspace One', '2026-01-01', '2026-01-01'),
      ('workspace-2', '${USERS.outsider}', 'Workspace Two', '2026-01-01', '2026-01-01');
    INSERT INTO folders (id, workspace_id, parent_id, name, normalized_name, path_key, deleted_at, created_at, updated_at) VALUES
      ('root-1', 'workspace-1', NULL, 'Root One', 'root one', 'root-1', NULL, '2026-01-01', '2026-01-01'),
      ('root-2', 'workspace-2', NULL, 'Root Two', 'root two', 'root-2', NULL, '2026-01-01', '2026-01-01'),
      ('deleted-folder-1', 'workspace-1', 'root-1', 'Deleted Folder', 'deleted folder', 'root-1/deleted-folder-1', '2026-01-02', '2026-01-01', '2026-01-02');
    INSERT INTO objects (id, workspace_id, folder_id, name, normalized_name, mime, size, sha256, part_count, status, storage_backend, visibility, deleted_at, created_at, updated_at) VALUES
      ('object-1', 'workspace-1', 'root-1', 'object.txt', 'object.txt', 'text/plain', 3, '${HASH}', 1, 'completed', 'bot_api', 'private', NULL, '2026-01-01', '2026-01-01'),
      ('object-upload', 'workspace-1', 'root-1', 'upload.txt', 'upload.txt', 'text/plain', 3, '${HASH}', 1, 'uploading', 'bot_api', 'private', NULL, '2026-01-01', '2026-01-01'),
      ('object-deleted', 'workspace-1', 'root-1', 'deleted.txt', 'deleted.txt', 'text/plain', 3, '${HASH}', 1, 'deleted', 'bot_api', 'private', '2026-01-02', '2026-01-01', '2026-01-02'),
      ('object-deleted-2', 'workspace-2', 'root-2', 'other-deleted.txt', 'other-deleted.txt', 'text/plain', 3, '${HASH}', 1, 'deleted', 'bot_api', 'private', '2026-01-02', '2026-01-01', '2026-01-02');
    INSERT INTO upload_sessions (id, user_id, object_id, status, chunk_size, expected_part_count, idempotency_key, expires_at, created_at, updated_at) VALUES
      ('upload-1', '${USERS.member}', 'object-upload', 'created', 8388608, 1, 'upload-key', '2099-01-01', '2026-01-01', '2026-01-01');
  `);
  const sessions = [
    [USERS.owner, SESSIONS.owner],
    [USERS.member, SESSIONS.member],
    [USERS.outsider, SESSIONS.outsider],
  ];
  for (const [userId, sessionId] of sessions) {
    db.prepare(
      'INSERT INTO sessions (id, user_id, token_hash, csrf_hash, expires_at, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(
      sessionId,
      userId,
      await secretHash(sessionId, SECRET),
      await secretHash(`csrf-${userId}`, SECRET),
      '2099-01-01',
      '2026-01-01',
      '2026-01-01',
    );
  }
  const env: Bindings = {
    DB: d1(db, hooks),
    APP_ORIGIN: 'http://localhost:3000',
    RP_ID: 'localhost',
    RP_NAME: 'Test',
    BOOTSTRAP_TOKEN: 'bootstrap',
    APP_SESSION_SECRET: SECRET,
    TELEGRAM_BOT_TOKENS: '111:token-one',
    TELEGRAM_SHARED_CHANNEL: '@pool',
    GOOGLE_REGISTRATION_SECRET: 'google-registration-secret',
  };
  return { db, env, hooks };
}

function request(user: keyof typeof SESSIONS, path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set('Cookie', `__Host-td_session=${SESSIONS[user]}`);
  if (init.method && init.method !== 'GET') {
    headers.set('Origin', 'http://localhost:3000');
    headers.set('X-CSRF-Token', `csrf-${USERS[user]}`);
  }
  return new Request(`http://worker.test${path}`, { ...init, headers });
}

async function addMember(fixture: Fixture): Promise<Response> {
  return app.fetch(
    request('owner', '/v1/workspaces/workspace-1/members', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: USERS.member }),
    }),
    fixture.env,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('workspace membership ACL', () => {
  it('allows owner and member workspace reads and reversible content changes', async () => {
    const test = await fixture();
    expect((await addMember(test)).status).toBe(200);

    const workspaces = await app.fetch(request('member', '/v1/workspaces'), test.env);
    expect(workspaces.status).toBe(200);
    expect((await workspaces.json()).workspaces[0].members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ userId: USERS.owner, role: 'owner' }),
        expect.objectContaining({ userId: USERS.member, role: 'member' }),
      ]),
    );
    expect((await app.fetch(request('member', '/v1/folders/root-1/children'), test.env)).status).toBe(200);
    expect((await app.fetch(request('member', '/v1/objects/recent'), test.env)).status).toBe(200);
    expect((await app.fetch(request('member', '/v1/export'), test.env)).status).toBe(200);

    const update = await app.fetch(
      request('member', '/v1/objects/object-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'member-renamed.txt' }),
      }),
      test.env,
    );
    expect(update.status).toBe(200);
    test.db.close();
  });

  it('denies nonmembers and cross-workspace resource escalation', async () => {
    const test = await fixture();
    expect((await app.fetch(request('member', '/v1/folders/root-1/children'), test.env)).status).toBe(404);
    expect((await app.fetch(request('outsider', '/v1/objects/object-1/manifest'), test.env)).status).toBe(404);
    expect((await app.fetch(request('owner', '/v1/folders/root-2/children'), test.env)).status).toBe(404);
    const mismatch = await app.fetch(
      request('owner', '/v1/workspaces/workspace-1/members', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: USERS.member, workspaceId: 'workspace-2' }),
      }),
      test.env,
    );
    expect(mismatch.status).toBe(422);
    test.db.close();
  });

  it('returns workspace and owner-only permanent-delete capability for visible trash rows', async () => {
    const test = await fixture();
    expect((await addMember(test)).status).toBe(200);
    const trash = async (user: keyof typeof SESSIONS) => {
      const response = await app.fetch(request(user, '/v1/trash'), test.env);
      expect(response.status).toBe(200);
      return (await response.json()) as { items: Array<Record<string, unknown>> };
    };

    const owner = await trash('owner');
    const ownerFolder = owner.items.find((item) => item.id === 'deleted-folder-1');
    const ownerObject = owner.items.find((item) => item.id === 'object-deleted');
    expect(owner.items.some((item) => item.id === 'object-deleted-2')).toBe(false);
    expect(ownerFolder).toMatchObject({
      type: 'folder',
      workspaceId: 'workspace-1',
      canPermanentlyDelete: true,
      parentId: 'root-1',
    });
    expect(ownerFolder).not.toHaveProperty('folderId');
    expect(ownerObject).toMatchObject({
      type: 'object',
      workspaceId: 'workspace-1',
      canPermanentlyDelete: true,
      folderId: 'root-1',
    });
    expect(ownerObject).not.toHaveProperty('parentId');
    for (const row of owner.items) {
      expect(typeof row.workspaceId).toBe('string');
      expect(typeof row.canPermanentlyDelete).toBe('boolean');
    }

    const member = await trash('member');
    expect(member.items.some((item) => item.id === 'object-deleted-2')).toBe(false);
    expect(member.items.find((item) => item.id === 'deleted-folder-1')).toMatchObject({
      workspaceId: 'workspace-1',
      canPermanentlyDelete: false,
    });
    expect(member.items.find((item) => item.id === 'object-deleted')).toMatchObject({
      workspaceId: 'workspace-1',
      canPermanentlyDelete: false,
    });
    for (const row of member.items) {
      expect(typeof row.workspaceId).toBe('string');
      expect(typeof row.canPermanentlyDelete).toBe('boolean');
    }
    test.db.close();
  });

  it('keeps membership reads/mutations and permanent deletion owner-only', async () => {
    const test = await fixture();
    expect((await addMember(test)).status).toBe(200);
    expect((await app.fetch(request('member', '/v1/workspaces/workspace-1/members'), test.env)).status).toBe(403);
    const memberDelete = await app.fetch(
      request('member', '/v1/objects/object-deleted/permanent', { method: 'DELETE' }),
      test.env,
    );
    expect(memberDelete.status).toBe(403);
    const ownerDelete = await app.fetch(
      request('owner', '/v1/objects/object-deleted/permanent', { method: 'DELETE' }),
      test.env,
    );
    expect(ownerDelete.status).toBe(200);
    const self = await app.fetch(
      request('owner', '/v1/workspaces/workspace-1/members', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: USERS.owner }),
      }),
      test.env,
    );
    expect(self.status).toBe(409);
    const duplicate = await addMember(test);
    expect(duplicate.status).toBe(409);
    const missing = await app.fetch(
      request('owner', '/v1/workspaces/workspace-1/members', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'missing-user' }),
      }),
      test.env,
    );
    expect(missing.status).toBe(404);
    test.db.close();
  });

  it('blocks generic part and complete writes when membership is revoked during their batch', async () => {
    const test = await fixture();
    expect((await addMember(test)).status).toBe(200);
    const start = await app.fetch(
      request('member', '/v1/uploads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'race.txt',
          size: 3,
          chunkSize: 8 * 1024 * 1024,
          partCount: 1,
          sha256: HASH,
          folderId: 'root-1',
          idempotencyKey: 'race-part',
        }),
      }),
      test.env,
    );
    expect(start.status).toBe(200);
    const started = (await start.json()) as { id: string; objectId: string };
    test.hooks.beforeBatch = () => test.db.prepare('DELETE FROM workspace_members WHERE workspace_id = ?').run('workspace-1');
    const part = await app.fetch(
      request('member', `/v1/uploads/${started.id}/parts/0`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ size: 3, sha256: HASH, messageId: 'race-message', idempotencyKey: 'race-part-0' }),
      }),
      test.env,
    );
    expect(part.status).not.toBe(200);
    expect((test.db.prepare('SELECT COUNT(*) AS count FROM object_parts WHERE object_id = ?').get(started.objectId) as { count: number }).count).toBe(0);
    expect((test.db.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE action = 'upload.part_committed'").get() as { count: number }).count).toBe(0);

    expect((await addMember(test)).status).toBe(200);
    const completeStart = await app.fetch(
      request('member', '/v1/uploads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'race-complete.txt',
          size: 3,
          chunkSize: 8 * 1024 * 1024,
          partCount: 1,
          sha256: HASH,
          folderId: 'root-1',
          idempotencyKey: 'race-complete',
        }),
      }),
      test.env,
    );
    const completeUpload = (await completeStart.json()) as { id: string; objectId: string };
    test.db.prepare("UPDATE upload_sessions SET status = 'uploading' WHERE id = ?").run(completeUpload.id);
    test.db.prepare(
      'INSERT INTO object_parts (id, object_id, part_no, size, sha256, message_id, bot_file_id, idempotency_key, created_at, bot_index) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run('complete-part', completeUpload.objectId, 0, 3, HASH, 'complete-message', null, 'complete-part-key', '2026-01-01', 0);
    test.hooks.beforeBatch = () => test.db.prepare('DELETE FROM workspace_members WHERE workspace_id = ?').run('workspace-1');
    const complete = await app.fetch(
      request('member', `/v1/uploads/${completeUpload.id}/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ partCount: 1, size: 3, sha256: HASH }),
      }),
      test.env,
    );
    expect(complete.status).not.toBe(200);
    expect((test.db.prepare('SELECT status FROM objects WHERE id = ?').get(completeUpload.objectId) as { status: string }).status).toBe('uploading');
    expect((test.db.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE action = 'upload.completed'").get() as { count: number }).count).toBe(0);
    test.db.close();
  });

  it('allows orphan Bot bytes but commits no part after revocation during paused send', async () => {
    const test = await fixture();
    expect((await addMember(test)).status).toBe(200);
    test.db.prepare('INSERT INTO telegram_pool (id, channel_id, bot_count, verified_at) VALUES (1, ?, 1, ?)').run('-1001', '2026-01-01');
    let resolveSend!: (response: Response) => void;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/sendDocument')) {
        await new Response(init?.body).arrayBuffer();
        return new Promise<Response>((resolve) => { resolveSend = resolve; });
      }
      return Response.json({ ok: false });
    });
    vi.stubGlobal('fetch', fetchMock);
    const sending = app.fetch(
      request('member', '/v1/bot/uploads/upload-1/parts/0', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Part-Size': '3',
          'X-Part-SHA256': HASH,
          'X-Idempotency-Key': 'paused-bot-part',
        },
        body: 'abc',
      }),
      test.env,
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect((await app.fetch(request('owner', `/v1/workspaces/workspace-1/members/${USERS.member}`, { method: 'DELETE' }), test.env)).status).toBe(200);
    resolveSend(Response.json({ ok: true, result: { message_id: 1, document: { file_id: 'orphan-file' } } }));
    const response = await sending;
    expect(response.status).not.toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((test.db.prepare('SELECT COUNT(*) AS count FROM object_parts WHERE object_id = ?').get('object-upload') as { count: number }).count).toBe(0);
    expect((test.db.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE action = 'upload.part_committed'").get() as { count: number }).count).toBe(0);
    expect((test.db.prepare('SELECT state FROM bot_part_attempts WHERE upload_session_id = ?').get('upload-1') as { state: string }).state).not.toBe('committed');
    test.db.close();
  });

  it('revocation blocks existing creator-bound upload and Bot API content access', async () => {
    const test = await fixture();
    expect((await addMember(test)).status).toBe(200);
    test.db.prepare(
      'INSERT INTO object_parts (id, object_id, part_no, size, sha256, message_id, bot_file_id, idempotency_key, created_at, bot_index) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run('part-1', 'object-1', 0, 3, HASH, 'message-1', 'file-1', 'part-key', '2026-01-01', 0);
    expect((await app.fetch(request('member', '/v1/uploads/upload-1'), test.env)).status).toBe(200);
    expect((await app.fetch(request('member', '/v1/bot/objects/object-1/manifest'), test.env)).status).toBe(200);

    const removed = await app.fetch(
      request('owner', `/v1/workspaces/workspace-1/members/${USERS.member}`, { method: 'DELETE' }),
      test.env,
    );
    expect(removed.status).toBe(200);
    expect((await app.fetch(request('member', '/v1/uploads/upload-1'), test.env)).status).toBe(404);
    expect((await app.fetch(request('member', '/v1/bot/objects/object-1/manifest'), test.env)).status).toBe(404);
    const contentFetch = vi.fn();
    vi.stubGlobal('fetch', contentFetch);
    const content = await app.fetch(
      request('member', '/v1/bot/objects/object-1/parts/0/content'),
      test.env,
    );
    expect(content.status).toBe(404);
    expect(contentFetch).not.toHaveBeenCalled();
    expect((await app.fetch(request('member', '/v1/bot/uploads/upload-1/parts/0/attempt'), test.env)).status).toBe(404);
    test.db.close();
  });
});
