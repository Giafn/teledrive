import { describe, expect, it } from 'vitest';
import app from '../src/index';
import { secretHash } from '../src/security';
import type { Bindings, D1Database, D1PreparedStatement } from '../src/types';

const secret = 'test-session-secret';

function environment(session?: Record<string, unknown>): Bindings {
  const statement = {
    bind(..._values: unknown[]) {
      return statement;
    },
    async first<T>() {
      return session as T | null;
    },
    async all<T>() {
      return { results: [] as T[], success: true };
    },
    async run() {
      return { success: true, meta: { changes: 0 } };
    },
  } as unknown as D1PreparedStatement;
  const db = {
    prepare(_query: string) {
      return statement;
    },
    async batch() {
      return [];
    },
  } as unknown as D1Database;
  return {
    DB: db,
    APP_ORIGIN: 'http://localhost:3000',
    RP_ID: 'localhost',
    RP_NAME: 'Test',
    BOOTSTRAP_TOKEN: 'bootstrap',
    APP_SESSION_SECRET: secret,
    TELEGRAM_WEBHOOK_SECRET: 'webhook',
  };
}

describe('GET /v1/auth/session', () => {
  it('returns only public user data for a valid opaque session cookie', async () => {
    const token = 'opaque-session-token';
    const response = await app.fetch(
      new Request('http://worker.test/v1/auth/session', {
        headers: { Cookie: `__Host-td_session=${token}` },
      }),
      environment({
        session_id: 'session-1',
        csrf_hash: await secretHash('csrf', secret),
        expires_at: '2099-01-01T00:00:00.000Z',
        id: 'user-1',
        username: 'alice',
        display_name: 'Alice',
        status: 'active',
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ user: { id: 'user-1', username: 'alice', displayName: 'Alice' } });
  });

  it('returns AUTH_REQUIRED without a session cookie', async () => {
    const response = await app.fetch(new Request('http://worker.test/v1/auth/session'), environment());

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: 'AUTH_REQUIRED' } });
  });
});
