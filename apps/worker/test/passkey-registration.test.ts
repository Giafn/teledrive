import { describe, expect, it } from 'vitest';
import app, { purgeChallenges } from '../src/index';
import type { Bindings, D1Database, D1PreparedStatement } from '../src/types';

describe('public passkey registration', () => {
  it('issues registration options without a bootstrap token', async () => {
    const queries: string[] = [];
    const db = {
      prepare(query: string) {
        queries.push(query);
        const statement = {
          bind(..._values: unknown[]) {
            return statement;
          },
          async first<T>() {
            if (query.includes('auth_rate_limits')) return { attempt_count: 1 } as T;
            if (query.includes('COUNT(*) AS count FROM users')) return { count: 1 } as T;
            return null as T | null;
          },
          async all<T>() {
            return { results: [] as T[], success: true };
          },
          async run() {
            return { success: true, meta: { changes: query.includes('auth_rate_limits') ? 1 : 0 } };
          },
        } as unknown as D1PreparedStatement;
        return statement;
      },
      async batch() {
        return [];
      },
    } as unknown as D1Database;
    const env: Bindings = {
      DB: db,
      APP_ORIGIN: 'http://localhost:3000',
      RP_ID: 'localhost',
      RP_NAME: 'Test',
      BOOTSTRAP_TOKEN: 'not-supplied',
      APP_SESSION_SECRET: 'test-session-secret',
      TELEGRAM_BOT_TOKENS: '111:token-one',
      TELEGRAM_SHARED_CHANNEL: '@pool',
    };
    const response = await app.fetch(
      new Request('http://worker.test/v1/auth/passkey/register/options', {
        method: 'POST',
        headers: {
          Origin: 'http://localhost:3000',
          Cookie: 'td_csrf=csrf-token',
          'X-CSRF-Token': 'csrf-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ userName: 'new-user', displayName: 'New User' }),
      }),
      env,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toHaveProperty('options.challenge');
    expect(queries.some((query) => query.includes('BOOTSTRAP_TOKEN'))).toBe(false);
  });

  it('allows retry after expired challenge purges orphan pending user', async () => {
    const state = { pending: false, validChallenge: false };
    const db = {
      prepare(query: string) {
        const statement = {
          query,
          bind(..._values: unknown[]) {
            return statement;
          },
          async first<T>() {
            if (query.includes('auth_rate_limits')) return { attempt_count: 1 } as T;
            if (query.includes('COUNT(*) AS count FROM users')) return { count: 0 } as T;
            if (query.includes('FROM sessions')) return null as T | null;
            if (query.includes('FROM users WHERE username'))
              return state.pending
                ? ({ id: 'pending-user', username: 'retry-user', display_name: 'Retry', status: 'pending' } as T)
                : null;
            return null as T | null;
          },
          async all<T>() {
            return { results: [] as T[], success: true };
          },
          async run() {
            return { success: true, meta: { changes: query.includes('auth_rate_limits') ? 1 : 0 } };
          },
        } as unknown as D1PreparedStatement & { query: string };
        return statement;
      },
      async batch(statements: (D1PreparedStatement & { query?: string })[]) {
        for (const statement of statements) {
          const query = statement.query ?? '';
          if (query.startsWith('DELETE FROM users') && !state.validChallenge) state.pending = false;
          if (query.includes('INSERT INTO users')) state.pending = true;
          if (query.includes('INSERT INTO webauthn_challenges')) state.validChallenge = true;
        }
        return statements.map(() => ({ success: true, meta: { changes: 1 } }));
      },
    } as unknown as D1Database;
    const env: Bindings = {
      DB: db,
      APP_ORIGIN: 'http://localhost:3000',
      RP_ID: 'localhost',
      RP_NAME: 'Test',
      BOOTSTRAP_TOKEN: 'not-supplied',
      APP_SESSION_SECRET: 'test-session-secret',
      TELEGRAM_BOT_TOKENS: '111:token-one',
      TELEGRAM_SHARED_CHANNEL: '@pool',
    };
    const request = () =>
      app.fetch(
        new Request('http://worker.test/v1/auth/passkey/register/options', {
          method: 'POST',
          headers: {
            Origin: 'http://localhost:3000',
            Cookie: 'td_csrf=csrf-token',
            'X-CSRF-Token': 'csrf-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ userName: 'retry-user', displayName: 'Retry' }),
        }),
        env,
      );
    expect((await request()).status).toBe(200);
    state.validChallenge = false;
    expect((await request()).status).toBe(200);
    expect(state.pending).toBe(true);
  });

  it('retains pending user after verification claims challenge until claim retention expires', async () => {
    const current = Date.parse('2026-08-06T00:00:00.000Z');
    const state = {
      pending: true,
      usedAt: new Date(current - 1_000).toISOString(),
      expiresAt: new Date(current + 60_000).toISOString(),
    };
    const db = {
      prepare(query: string) {
        const statement = {
          bind(..._values: unknown[]) {
            return statement;
          },
        } as unknown as D1PreparedStatement & { query: string };
        statement.query = query;
        return statement;
      },
      async batch(statements: (D1PreparedStatement & { query?: string })[]) {
        for (const statement of statements) {
          const query = statement.query ?? '';
          if (query.startsWith('DELETE FROM webauthn_challenges') && Date.parse(state.usedAt) < current - 10 * 60_000) {
            state.usedAt = '';
          }
          if (query.startsWith('DELETE FROM users') && !state.usedAt) state.pending = false;
        }
        return statements.map(() => ({ success: true, meta: { changes: 1 } }));
      },
    } as unknown as D1Database;

    await purgeChallenges(db, current);
    expect(state.pending).toBe(true);

    state.usedAt = new Date(current - 11 * 60_000).toISOString();
    await purgeChallenges(db, current);
    expect(state.pending).toBe(false);
  });
});
