import { afterEach, describe, expect, it, vi } from 'vitest';
import app, { poolBotIndex } from '../src/index';
import { secretHash } from '../src/security';
import type { Bindings, D1Database, D1PreparedStatement } from '../src/types';

const session = {
  session_id: 'session-1',
  csrf_hash: '',
  expires_at: '2099-01-01T00:00:00.000Z',
  id: 'user-1',
  username: 'alice',
  display_name: 'Alice',
  status: 'active',
};
const secret = 'test-session-secret';
const BOTS = '111:token-one,222:token-two';

function environment(overrides: { cachedPool?: Record<string, unknown> | null } = {}) {
  const state: {
    cachedPool: Record<string, unknown> | null;
  } = {
    cachedPool: overrides.cachedPool ?? null,
  };
  const db = {
    prepare(query: string) {
      const statement = {
        query,
        bind(..._values: unknown[]) {
          return statement;
        },
        async first<T>() {
          if (query.includes('FROM sessions')) return session as T;
          if (query.includes('FROM telegram_pool')) return state.cachedPool as T | null;
          return null as T | null;
        },
        async all<T>() {
          return { results: [] as T[], success: true };
        },
        async run() {
          return { success: true, meta: { changes: 1 } };
        },
      } as unknown as D1PreparedStatement & { query: string };
      return statement;
    },
    async batch(statements: (D1PreparedStatement & { query?: string })[]) {
      statements.forEach((statement) => {
        if ((statement.query ?? '').includes('INSERT INTO telegram_pool'))
          state.cachedPool = { id: 1, channel_id: '-1001', bot_count: 2, verified_at: 'now' };
      });
      return [{ success: true, meta: { changes: 1 } }];
    },
  } as unknown as D1Database;
  const env: Bindings = {
    DB: db,
    APP_ORIGIN: 'http://localhost:3000',
    RP_ID: 'localhost',
    RP_NAME: 'Test',
    BOOTSTRAP_TOKEN: 'bootstrap',
    APP_SESSION_SECRET: secret,
    TELEGRAM_BOT_TOKENS: BOTS,
    TELEGRAM_SHARED_CHANNEL: '@pool',
    GOOGLE_REGISTRATION_SECRET: 'registration-secret',
  };
  return { env, state };
}

afterEach(() => vi.unstubAllGlobals());

describe('shared bot pool', () => {
  it('hashes idempotency keys deterministically across pool sizes', () => {
    expect(poolBotIndex('abc', 1)).toBe(0);
    const withTwo = poolBotIndex('abc', 2);
    expect(withTwo).toBeGreaterThanOrEqual(0);
    expect(withTwo).toBeLessThan(2);
    expect(poolBotIndex('abc', 2)).toBe(withTwo);
    expect(poolBotIndex('def', 2)).toBe(poolBotIndex('def', 2));
  });

  it('reports a ready pool after resolving the shared channel', async () => {
    const { env } = await environment();
    session.csrf_hash = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).endsWith('/getChat'))
          return Response.json({ ok: true, result: { id: -1001, type: 'channel', username: 'pool' } });
        return Response.json({ ok: false });
      }),
    );
    const response = await app.fetch(new Request('http://worker.test/v1/telegram/pool'), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      channel: '@pool',
      botCount: 2,
      ready: true,
      reason: { code: 'READY', message: 'Storage pool is ready' },
    });
  });

  it('reports Telegram API rejection for a rejected payload with sanitized description', async () => {
    const { env } = await environment();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ ok: false, description: 'chat not found\nfor token-one' })),
    );
    const response = await app.fetch(new Request('http://worker.test/v1/telegram/pool'), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      channel: '@pool',
      botCount: 2,
      ready: false,
      reason: {
        code: 'GET_CHAT_API_REJECTION',
        message: 'Telegram getChat API rejected the request (HTTP 200): chat not found for [redacted]',
      },
    });
  });

  it('reports Telegram API rejection for a rejected HTTP status without exposing the raw response', async () => {
    const { env } = await environment();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ ok: false, description: 'Bad Request: chat not found' }, { status: 400 })),
    );
    const response = await app.fetch(new Request('http://worker.test/v1/telegram/pool'), env);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({
      channel: '@pool',
      botCount: 2,
      ready: false,
      reason: {
        code: 'GET_CHAT_API_REJECTION',
        message: 'Telegram getChat API rejected the request (HTTP 400): Bad Request: chat not found',
      },
    });
    expect(body).not.toContain('token-one');
  });

  it('reports network failures as transport failures', async () => {
    const { env } = await environment();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network details');
      }),
    );
    const response = await app.fetch(new Request('http://worker.test/v1/telegram/pool'), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      channel: '@pool',
      botCount: 2,
      ready: false,
      reason: { code: 'GET_CHAT_TRANSPORT_FAILURE', message: 'Telegram getChat transport failed' },
    });
  });

  it('reports a missing shared channel', async () => {
    const { env } = await environment();
    env.TELEGRAM_SHARED_CHANNEL = '';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const response = await app.fetch(new Request('http://worker.test/v1/telegram/pool'), env);
    expect(await response.json()).toEqual({
      channel: '',
      botCount: 2,
      ready: false,
      reason: { code: 'CHANNEL_MISSING', message: 'Shared Telegram channel is not configured' },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports an empty pool when no bots are configured', async () => {
    const { env } = await environment();
    env.TELEGRAM_BOT_TOKENS = '';
    const response = await app.fetch(new Request('http://worker.test/v1/telegram/pool'), env);
    expect(await response.json()).toEqual({
      channel: '',
      botCount: 0,
      ready: false,
      reason: { code: 'NO_VALID_BOTS', message: 'No valid Telegram bot tokens are configured' },
    });
  });

  it('reports no valid bots when configured entries cannot be parsed', async () => {
    const { env } = await environment();
    env.TELEGRAM_BOT_TOKENS = 'not-a-bot-token';
    const response = await app.fetch(new Request('http://worker.test/v1/telegram/pool'), env);
    expect(await response.json()).toEqual({
      channel: '',
      botCount: 0,
      ready: false,
      reason: { code: 'NO_VALID_BOTS', message: 'No valid Telegram bot tokens are configured' },
    });
  });

  it('caches the resolved channel and reuses it without calling Telegram', async () => {
    const { env } = await environment({ cachedPool: { id: 1, channel_id: '-1001', bot_count: 2, verified_at: 'now' } });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const response = await app.fetch(new Request('http://worker.test/v1/telegram/pool'), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      channel: '@pool',
      botCount: 2,
      ready: true,
      reason: { code: 'READY', message: 'Storage pool is ready' },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('removed legacy onboarding, link, and webhook routes', async () => {
    const { env } = await environment();
    session.csrf_hash = await secretHash('csrf-token', secret);
    const headers = {
      Origin: 'http://localhost:3000',
      Cookie: '__Host-td_session=opaque-session-token',
      'X-CSRF-Token': 'csrf-token',
      'Content-Type': 'application/json',
    };
    const legacy = [
      new Request('http://worker.test/v1/telegram/bot', { method: 'POST', headers, body: '{}' }),
      new Request('http://worker.test/v1/telegram/bot/revoke', { method: 'POST', headers, body: '{}' }),
      new Request('http://worker.test/v1/telegram/bot/reset', { method: 'POST', headers, body: '{}' }),
      new Request('http://worker.test/v1/telegram/link', {
        headers: { Cookie: '__Host-td_session=opaque-session-token' },
      }),
      new Request('http://worker.test/v1/telegram/link', { method: 'POST', headers, body: '{}' }),
      new Request('http://worker.test/v1/webhooks/telegram', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }),
      new Request('http://worker.test/v1/webhooks/telegram/bot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }),
    ];
    for (const request of legacy) {
      const response = await app.fetch(request, env);
      expect([404, 405].includes(response.status)).toBe(true);
    }
  });
});
