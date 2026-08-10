import { afterEach, describe, expect, it, vi } from 'vitest';
import app, { poolBotIndex } from '../src/index';
import { secretHash } from '../src/security';
import type { Bindings, D1Database, D1PreparedStatement } from '../src/types';

const APP_SECRET = 'test-session-secret';
const BOTS = '111:token-one,222:token-two';
const CHANNEL = '@pool';
const CHANNEL_ID = '-1001';
const PART_HASH = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

interface State {
  sessionUser: string;
  upload: Record<string, unknown> | null;
  object: Record<string, unknown> | null;
  part: Record<string, unknown> | null;
  attempt: Record<string, unknown> | null;
  parts: Record<string, unknown>[];
  auditCount: number;
  reservationRace: boolean;
  raceReadWinner: boolean;
}

async function environment(overrides: Partial<State> = {}): Promise<{ env: Bindings; state: State }> {
  const state: State = {
    sessionUser: 'owner-1',
    upload: {
      id: 'upload-1',
      user_id: 'owner-1',
      object_id: 'object-1',
      status: 'uploading',
      chunk_size: 3,
      expected_part_count: 1,
      idempotency_key: 'upload-key',
      expires_at: '2099-01-01T00:00:00.000Z',
      object_name: 'file.txt',
      mime: 'text/plain',
      object_size: 3,
      object_sha256: PART_HASH,
      object_status: 'uploading',
      object_deleted_at: null,
      folder_id: 'folder-1',
    },
    object: {
      id: 'object-1',
      folder_id: 'folder-1',
      name: 'file.txt',
      mime: 'text/plain',
      size: 3,
      sha256: PART_HASH,
      part_count: 1,
      status: 'completed',
      deleted_at: null,
      owner_id: 'owner-1',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    },
    part: null,
    attempt: null,
    parts: [{ part_no: 0, size: 3, sha256: PART_HASH }],
    auditCount: 0,
    reservationRace: false,
    raceReadWinner: false,
    ...overrides,
  };
  const session = {
    session_id: 'session-1',
    csrf_hash: await secretHash('csrf-token', APP_SECRET),
    expires_at: '2099-01-01T00:00:00.000Z',
    id: state.sessionUser,
    username: 'alice',
    display_name: 'Alice',
    status: 'active',
  };
  const db = {
    prepare(query: string) {
      let values: unknown[] = [];
      const statement = {
        query,
        bound: [] as unknown[],
        bind(...bound: unknown[]) {
          values = bound;
          statement.bound = bound;
          return statement;
        },
        async first<T>() {
          if (query.includes('FROM sessions')) return session as T;
          if (query.includes('FROM telegram_pool'))
            return { id: 1, channel_id: CHANNEL_ID, bot_count: 2, verified_at: 'now' } as T;
          if (query.includes('FROM object_parts')) return state.part as T | null;
          if (query.includes('FROM bot_part_attempts'))
            return (state.reservationRace && !state.raceReadWinner ? null : state.attempt) as T | null;
          if (query.includes('FROM upload_sessions us')) return state.upload as T | null;
          if (query.includes('FROM objects o')) {
            const requestedUser = String(values[1] ?? '');
            if (state.object && state.object.owner_id === requestedUser) return state.object as T;
            return null as T | null;
          }
          if (query.includes('FROM workspaces')) return { id: 'workspace-1', name: 'My Drive' } as T;
          if (query.includes('FROM folders'))
            return { id: 'folder-1', parent_id: null, name: 'My Drive', deleted_at: null } as T;
          return null as T | null;
        },
        async all<T>() {
          if (query.includes('SELECT part_no, size, sha256 FROM object_parts'))
            return { results: state.parts as T[], success: true };
          return { results: [] as T[], success: true };
        },
        async run() {
          // INSERT INTO bot_part_attempts (id, upload_session_id, part_no, idempotency_key, expected_size, expected_sha256, state, reserved_at, created_at, updated_at, bot_index)
          if (query.includes('INSERT INTO bot_part_attempts')) {
            if (state.reservationRace && !state.raceReadWinner) {
              state.raceReadWinner = true;
              return { success: true, meta: { changes: 0 } };
            }
            if (state.upload && Date.parse(String(state.upload.expires_at)) <= Date.now())
              return { success: true, meta: { changes: 0 } };
            state.attempt = {
              id: String(values[0]),
              upload_session_id: String(values[1]),
              part_no: Number(values[2]),
              idempotency_key: String(values[3]),
              expected_size: Number(values[4]),
              expected_sha256: String(values[5]),
              state: 'reserved',
              telegram_message_id: null,
              telegram_file_id: null,
              send_generation: null,
              sending_lease_until: null,
              reserved_at: String(values[7]),
              sending_at: null,
              sent_at: null,
              ambiguous_at: null,
              committed_at: null,
              abandoned_at: null,
              created_at: String(values[8]),
              updated_at: String(values[9]),
              bot_index: Number(values[10]),
            };
            return { success: true, meta: { changes: 1 } };
          }
          // SET state='sending', sending_at=?, send_generation=?, sending_lease_until=?, updated_at=? WHERE id=? AND state='reserved'
          if (query.includes("SET state = 'sending'")) {
            if (state.attempt?.state !== 'reserved') return { success: true, meta: { changes: 0 } };
            state.attempt = {
              ...state.attempt,
              state: 'sending',
              sending_at: String(values[0]),
              send_generation: String(values[1]),
              sending_lease_until: String(values[2]),
              updated_at: String(values[3]),
            };
            return { success: true, meta: { changes: 1 } };
          }
          // SET state='sent', telegram_message_id=?, telegram_file_id=?, sent_at=?, sending_lease_until=NULL, updated_at=? WHERE id=? AND state='sending' AND send_generation=?
          if (query.includes("SET state = 'sent'")) {
            if (
              state.attempt?.state !== 'sending' ||
              String(state.attempt.send_generation) !== String(values[5]) ||
              typeof state.attempt.sending_lease_until !== 'string' ||
              Date.parse(String(state.attempt.sending_lease_until)) <= Date.now()
            )
              return { success: true, meta: { changes: 0 } };
            state.attempt = {
              ...state.attempt,
              state: 'sent',
              telegram_message_id: String(values[0]),
              telegram_file_id: String(values[1]),
              sent_at: String(values[2]),
              sending_lease_until: null,
              updated_at: String(values[3]),
            };
            return { success: true, meta: { changes: 1 } };
          }
          // sending -> ambiguous (expired lease, generation-guarded)
          if (query.includes("SET state = 'ambiguous'") && query.includes('sending_lease_until')) {
            const lease = state.attempt?.sending_lease_until;
            if (
              state.attempt?.state !== 'sending' ||
              String(state.attempt.send_generation) !== String(values[3]) ||
              (typeof lease === 'string' && Date.parse(lease) > Date.parse(String(values[4])))
            )
              return { success: true, meta: { changes: 0 } };
            state.attempt = {
              ...state.attempt,
              state: 'ambiguous',
              ambiguous_at: String(values[0]),
              sending_lease_until: null,
              updated_at: String(values[1]),
            };
            return { success: true, meta: { changes: 1 } };
          }
          // reserved/sent -> ambiguous (generation-guarded)
          if (query.includes("SET state = 'ambiguous'")) {
            if (
              !state.attempt ||
              !['reserved', 'sending', 'sent'].includes(String(state.attempt.state)) ||
              (values.length >= 4 && String(state.attempt.send_generation) !== String(values[3]))
            )
              return { success: true, meta: { changes: 0 } };
            state.attempt = {
              ...state.attempt,
              state: 'ambiguous',
              ambiguous_at: String(values[0]),
              sending_lease_until: null,
              updated_at: String(values[1]),
            };
            return { success: true, meta: { changes: 1 } };
          }
          // SET state='abandoned', abandoned_at=?, send_generation=NULL, updated_at=? WHERE id=? AND send_generation=?
          if (query.includes("SET state = 'abandoned'")) {
            if (String(state.attempt?.send_generation) !== String(values[3]))
              return { success: true, meta: { changes: 0 } };
            state.attempt = {
              ...state.attempt,
              state: 'abandoned',
              send_generation: null,
              abandoned_at: String(values[0]),
              updated_at: String(values[1]),
            };
            return { success: true, meta: { changes: 1 } };
          }
          return { success: true, meta: { changes: 1 } };
        },
      } as unknown as D1PreparedStatement & { query: string; bound: unknown[] };
      return statement;
    },
    async batch<T extends D1PreparedStatement>(statements: T[]) {
      const rows = statements as (T & { query: string; bound: unknown[] })[];
      const commit = rows.find((statement) => statement.query.includes("SET state = 'committed'"));
      const partInsert = rows.find((statement) => statement.query.includes('INSERT INTO object_parts'));
      if (commit) {
        const generation = String(commit.bound[3]);
        if (state.attempt?.state === 'sent' && String(state.attempt.send_generation) === generation) {
          state.attempt = { ...state.attempt, state: 'committed', committed_at: String(commit.bound[0]) };
          if (partInsert) {
            state.part = {
              id: String(partInsert.bound[0]),
              object_id: String(partInsert.bound[1]),
              part_no: Number(partInsert.bound[2]),
              size: Number(partInsert.bound[3]),
              sha256: String(partInsert.bound[4]),
              message_id: String(partInsert.bound[5]),
              bot_file_id: String(partInsert.bound[6]),
              idempotency_key: String(partInsert.bound[7]),
              created_at: String(partInsert.bound[8]),
              bot_index: Number(partInsert.bound[9]),
            };
          }
        }
      }
      rows.forEach((statement) => {
        if (statement.query.includes('INSERT INTO audit_events')) state.auditCount += 1;
      });
      return rows.map(() => ({ success: true, meta: { changes: 1 } }));
    },
  } as unknown as D1Database;
  const env: Bindings = {
    DB: db,
    APP_ORIGIN: 'http://localhost:3000',
    RP_ID: 'localhost',
    RP_NAME: 'Test',
    BOOTSTRAP_TOKEN: 'bootstrap',
    APP_SESSION_SECRET: APP_SECRET,
    TELEGRAM_BOT_TOKENS: BOTS,
    TELEGRAM_SHARED_CHANNEL: CHANNEL,
  };
  return { env, state };
}

function authHeaders(): HeadersInit {
  return {
    Origin: 'http://localhost:3000',
    Cookie: '__Host-td_session=opaque-session-token',
    'X-CSRF-Token': 'csrf-token',
  };
}

function partRequest(partNo = 0, key = 'part-key', size = '3', sha256 = PART_HASH): Request {
  return new Request(`http://worker.test/v1/bot/uploads/upload-1/parts/${partNo}`, {
    method: 'PUT',
    headers: {
      ...authHeaders(),
      'Content-Type': 'application/octet-stream',
      'X-Part-Size': size,
      'X-Part-SHA256': sha256,
      'X-Idempotency-Key': key,
    },
    body: 'abc',
  });
}

function telegramSendOk(messageId: number, fileId: string): Response {
  return Response.json({ ok: true, result: { message_id: messageId, document: { file_id: fileId } } });
}

function stubTelegram(fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): void {
  vi.stubGlobal('fetch', vi.fn(fetchImpl));
}

afterEach(() => vi.unstubAllGlobals());

describe('Bot API data plane (shared pool)', () => {
  it('starts uploads through the bot alias and enforces size limits', async () => {
    const { env } = await environment();
    const start = await app.fetch(
      new Request('http://worker.test/v1/bot/uploads', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'x',
          size: 3,
          chunkSize: 16 * 1024 * 1024,
          partCount: 1,
          sha256: PART_HASH,
          idempotencyKey: 'k',
        }),
      }),
      env,
    );
    expect(start.status).toBe(200);
    const body = (await start.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ objectId: 'object-1', status: 'created', expectedPartCount: 1 });
    expect(body).toHaveProperty('id');

    const tooLarge = await environment();
    const rejected = await app.fetch(
      new Request('http://worker.test/v1/bot/uploads', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'x',
          size: 5 * 1024 * 1024 * 1024 + 1,
          chunkSize: 19 * 1024 * 1024,
          partCount: 1,
          sha256: PART_HASH,
          idempotencyKey: 'k',
        }),
      }),
      tooLarge.env,
    );
    expect(rejected.status).toBe(413);
  });

  it('rejects part PUT when the pool has no bots', async () => {
    const { env } = await environment();
    env.TELEGRAM_BOT_TOKENS = '';
    const send = vi.fn();
    stubTelegram(send);
    const response = await app.fetch(partRequest(), env);
    expect(response.status).toBe(409);
    expect(send).not.toHaveBeenCalled();
  });

  it('streams multipart to the pinned pool bot and handles idempotent retry/conflict', async () => {
    const { env, state } = await environment();
    let sendBody = '';
    let sendCount = 0;
    stubTelegram(async (input, init) => {
      if (String(input).endsWith('/sendDocument')) {
        sendCount += 1;
        sendBody = await new Response(init?.body as ReadableStream<Uint8Array>).text();
        return telegramSendOk(7, 'telegram-file-id');
      }
      return Response.json({ ok: false });
    });
    const response = await app.fetch(partRequest(), env);
    expect(response.status).toBe(200);
    expect(sendBody).toContain('name="chat_id"');
    expect(sendBody).toContain('name="document"');
    expect(sendBody).toContain('abc');
    expect(await response.json()).not.toHaveProperty('fileId');
    expect(state.attempt).toMatchObject({ state: 'committed', idempotency_key: 'part-key' });
    expect(state.part).toMatchObject({ idempotency_key: 'part-key', message_id: '7', bot_file_id: 'telegram-file-id' });
    expect(state.attempt?.bot_index).toBe(poolBotIndex('part-key', 2));

    state.part = {
      id: 'part-1',
      object_id: 'object-1',
      part_no: 0,
      size: 3,
      sha256: PART_HASH,
      idempotency_key: 'part-key',
    };
    const retry = await app.fetch(partRequest(), env);
    expect(retry.status).toBe(200);
    expect(sendCount).toBe(1);

    state.part = { ...state.part!, sha256: '0'.repeat(64) };
    const conflict = await app.fetch(partRequest(), env);
    expect(conflict.status).toBe(409);
    expect(JSON.stringify(await conflict.json())).not.toContain('telegram-file-id');
  });

  it('claims a crash-reserved attempt and sends exactly once', async () => {
    const { env, state } = await environment({
      attempt: {
        id: 'attempt-reserved',
        upload_session_id: 'upload-1',
        part_no: 0,
        idempotency_key: 'crash-key',
        expected_size: 3,
        expected_sha256: PART_HASH,
        state: 'reserved',
        send_generation: null,
        sending_lease_until: null,
        bot_index: poolBotIndex('crash-key', 2),
      },
    });
    let sendCount = 0;
    stubTelegram(async (input, init) => {
      if (String(input).endsWith('/sendDocument')) {
        sendCount += 1;
        await new Response(init?.body as ReadableStream<Uint8Array>).text();
        return telegramSendOk(8, 'file-8');
      }
      return Response.json({ ok: false });
    });
    const response = await app.fetch(partRequest(0, 'crash-key'), env);
    expect(response.status).toBe(200);
    expect(sendCount).toBe(1);
    expect(state.attempt?.state).toBe('committed');
  });

  it('turns stale sending attempts ambiguous without sending', async () => {
    const { env, state } = await environment({
      attempt: {
        id: 'attempt-stale',
        upload_session_id: 'upload-1',
        part_no: 0,
        idempotency_key: 'stale-key',
        expected_size: 3,
        expected_sha256: PART_HASH,
        state: 'sending',
        send_generation: 'generation-stale',
        sending_lease_until: '2000-01-01T00:00:00.000Z',
        bot_index: 0,
      },
    });
    const send = vi.fn();
    stubTelegram(send);
    const response = await app.fetch(partRequest(0, 'stale-key'), env);
    expect(response.status).toBe(409);
    expect(state.attempt?.state).toBe('ambiguous');
    expect(send).not.toHaveBeenCalled();
  });

  it('returns the durable winner when reservation insert races', async () => {
    const lease = new Date(Date.now() + 60_000).toISOString();
    const { env, state } = await environment({
      reservationRace: true,
      attempt: {
        id: 'attempt-winner',
        upload_session_id: 'upload-1',
        part_no: 0,
        idempotency_key: 'race-key',
        expected_size: 3,
        expected_sha256: PART_HASH,
        state: 'sending',
        send_generation: 'generation-winner',
        sending_lease_until: lease,
        bot_index: 0,
      },
    });
    const send = vi.fn();
    stubTelegram(send);
    const response = await app.fetch(partRequest(0, 'race-key'), env);
    expect(response.status).toBe(409);
    expect(state.attempt?.id).toBe('attempt-winner');
    expect(state.attempt?.state).toBe('sending');
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects old sender response after stale, abandon, and new-generation send', async () => {
    const { env, state } = await environment();
    let resolveTelegram!: (response: Response) => void;
    const telegramResponse = new Promise<Response>((resolve) => {
      resolveTelegram = resolve;
    });
    let resolveReplacement!: (response: Response) => void;
    const replacementResponse = new Promise<Response>((resolve) => {
      resolveReplacement = resolve;
    });
    let sendCount = 0;
    stubTelegram(async (input, init) => {
      if (String(input).endsWith('/sendDocument')) {
        sendCount += 1;
        await new Response(init?.body as ReadableStream<Uint8Array>).text();
        if (sendCount === 1) return telegramResponse;
        return replacementResponse;
      }
      return Response.json({ ok: false });
    });
    const first = app.fetch(partRequest(0, 'late-key'), env);
    await vi.waitFor(() => expect(state.attempt?.state).toBe('sending'));
    state.attempt = { ...state.attempt!, sending_lease_until: '2000-01-01T00:00:00.000Z' };
    const stale = await app.fetch(partRequest(0, 'late-key'), env);
    expect(stale.status).toBe(409);
    expect(state.attempt?.state).toBe('ambiguous');
    const abandon = await app.fetch(
      new Request('http://worker.test/v1/bot/uploads/upload-1/parts/0/attempt/abandon', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: '{}',
      }),
      env,
    );
    expect(abandon.status).toBe(200);
    expect(await abandon.json()).toMatchObject({ partNo: 0, status: 'abandoned' });
    const auditsBeforeReplacement = state.auditCount;
    const replacement = app.fetch(partRequest(0, 'new-key'), env);
    await vi.waitFor(() => {
      expect(sendCount).toBe(2);
      expect(state.attempt?.state).toBe('sending');
    });
    const replacementGeneration = state.attempt?.send_generation;
    expect(replacementGeneration).toBeTruthy();
    resolveTelegram(telegramSendOk(9, 'file-9'));
    const late = await first;
    expect(late.status).not.toBe(200);
    expect(state.attempt?.state).toBe('sending');
    expect(state.attempt?.send_generation).toBe(replacementGeneration);
    expect(state.attempt?.telegram_message_id).toBeNull();
    expect(state.attempt?.telegram_file_id).toBeNull();
    expect(state.part).toBeNull();
    expect(state.auditCount).toBe(auditsBeforeReplacement);

    resolveReplacement(telegramSendOk(10, 'file-new'));
    expect(await replacement).toMatchObject({ status: 200 });
    expect(state.attempt).toMatchObject({
      state: 'committed',
      send_generation: replacementGeneration,
      idempotency_key: 'new-key',
      telegram_message_id: '10',
      telegram_file_id: 'file-new',
    });
    expect(state.part).toMatchObject({
      idempotency_key: 'new-key',
      message_id: '10',
      bot_file_id: 'file-new',
      sha256: PART_HASH,
    });
    expect(state.auditCount).toBe(auditsBeforeReplacement + 1);
  });

  it('restricts object reads to the owner and streams sanitized download from the pinned bot', async () => {
    const denied = await environment({ sessionUser: 'reader-2' });
    const deniedManifest = await app.fetch(
      new Request('http://worker.test/v1/bot/objects/object-1/manifest', { headers: authHeaders() }),
      denied.env,
    );
    expect(deniedManifest.status).toBe(404);

    const owned = await environment({
      part: { part_no: 0, size: 3, sha256: PART_HASH, bot_file_id: 'telegram-file-id', bot_index: 1 },
    });
    const manifest = await app.fetch(
      new Request('http://worker.test/v1/bot/objects/object-1/manifest', { headers: authHeaders() }),
      owned.env,
    );
    expect(manifest.status).toBe(200);
    const manifestBody = JSON.stringify(await manifest.json());
    expect(manifestBody).not.toContain('telegram-file-id');
    expect(manifestBody).not.toContain('file_path');
    expect(manifestBody).not.toContain('token-');

    const fileResponse = new Response('abc', { headers: { 'Content-Type': 'application/octet-stream' } });
    const requested: string[] = [];
    stubTelegram(async (input) => {
      requested.push(String(input));
      if (String(input).endsWith('/getFile'))
        return Response.json({ ok: true, result: { file_path: 'files/private-path' } });
      if (String(input).includes('/file/bot')) return fileResponse;
      return Response.json({ ok: false });
    });
    const content = await app.fetch(
      new Request('http://worker.test/v1/bot/objects/object-1/parts/0/content', { headers: authHeaders() }),
      owned.env,
    );
    const contentText = await content.text();
    expect(contentText).toBe('abc');
    expect(content.headers.get('Content-Type')).toBe('text/plain');
    const getFileUrl = requested.find((url) => url.endsWith('/getFile')) ?? '';
    expect(getFileUrl).toContain('token-two');
    expect(JSON.stringify(contentText)).not.toContain('token-two');
  });

  it('sanitizes Telegram 429 responses, abandons the attempt, and returns retry timing', async () => {
    const { env, state } = await environment();
    stubTelegram(async (_input, init) => {
      await new Response(init?.body as ReadableStream<Uint8Array>).text();
      return new Response('Telegram temporarily unavailable', { status: 429, headers: { 'Retry-After': '9' } });
    });
    const response = await app.fetch(partRequest(0, 'retry-key'), env);
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('9');
    expect(response.headers.get('Access-Control-Expose-Headers')).toContain('Retry-After');
    expect(JSON.stringify(await response.json())).not.toContain('token-');
    expect(state.attempt?.state).toBe('abandoned');
    expect(state.part).toBeNull();
  });

  it('marks transport failures ambiguous instead of committing', async () => {
    const { env, state } = await environment();
    stubTelegram(async () => {
      throw new TypeError('network down');
    });
    const response = await app.fetch(partRequest(0, 'transport-key'), env);
    expect(response.status).toBe(502);
    expect(state.attempt?.state).toBe('ambiguous');
    expect(state.part).toBeNull();
  });

  it('honors durable reservations and never resends ambiguous attempts until explicit abandonment', async () => {
    const { env, state } = await environment({
      attempt: {
        id: 'attempt-1',
        upload_session_id: 'upload-1',
        part_no: 0,
        idempotency_key: 'ambiguous-key',
        expected_size: 3,
        expected_sha256: PART_HASH,
        state: 'ambiguous',
        send_generation: 'generation-ambiguous',
        telegram_message_id: '7',
        telegram_file_id: 'telegram-file-id',
        sending_lease_until: null,
        bot_index: 0,
      },
    });
    const send = vi.fn();
    stubTelegram(send);
    const status = await app.fetch(
      new Request('http://worker.test/v1/bot/uploads/upload-1/parts/0/attempt', { headers: authHeaders() }),
      env,
    );
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ partNo: 0, status: 'ambiguous' });

    state.attempt = { ...state.attempt!, state: 'sending', sending_lease_until: new Date(Date.now() + 60_000).toISOString() };
    const inProgress = await app.fetch(partRequest(0, 'ambiguous-key'), env);
    expect(inProgress.status).toBe(409);
    expect(send).not.toHaveBeenCalled();
    state.attempt = { ...state.attempt!, state: 'ambiguous' };

    const retry = await app.fetch(partRequest(0, 'ambiguous-key'), env);
    expect(retry.status).toBe(409);
    expect(send).not.toHaveBeenCalled();

    const abandon = await app.fetch(
      new Request('http://worker.test/v1/bot/uploads/upload-1/parts/0/attempt/abandon', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: '{}',
      }),
      env,
    );
    expect(abandon.status).toBe(200);
    expect(await abandon.json()).toMatchObject({ partNo: 0, status: 'abandoned' });
  });

  it('does not send, insert a part, or audit after session expiry', async () => {
    const { env, state } = await environment();
    state.upload = { ...state.upload!, expires_at: '2000-01-01T00:00:00.000Z' };
    const send = vi.fn();
    stubTelegram(send);
    const response = await app.fetch(partRequest(0, 'expired-key'), env);
    expect(response.status).toBe(409);
    expect(send).not.toHaveBeenCalled();
    expect(state.part).toBeNull();
    expect(state.auditCount).toBe(0);
  });
});
