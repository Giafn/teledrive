import { afterEach, describe, expect, it, vi } from 'vitest';
import { jwtVerify } from 'jose';
import app from '../src/index';
import { secretHash } from '../src/security';
import type { Bindings, D1Database, D1PreparedStatement, UserRow } from '../src/types';

vi.mock('jose', () => ({
  createRemoteJWKSet: vi.fn(() => ({})),
  jwtVerify: vi.fn(),
}));

const SESSION_SECRET = 'test-session-secret';
const REGISTRATION_SECRET = 'registration-secret';
const NONCE = 'test-nonce';

type OAuthMode = 'login' | 'link' | 'register';

interface State {
  oauthMode?: OAuthMode;
  oauthInserted: boolean;
  oauthClaimed: boolean;
  batchQueries: string[];
  sessionCreated: boolean;
  identity: { user_id: string } | null;
  user: UserRow | null;
  tx: {
    id: string;
    nonce_hash: string;
    code_verifier: string;
    mode: OAuthMode;
    user_id: string | null;
    issued_session_id: string | null;
  };
}

function environment(overrides: Partial<Pick<State, 'identity' | 'user'>> = {}): { env: Bindings; state: State } {
  const state: State = {
    oauthInserted: false,
    oauthClaimed: false,
    batchQueries: [],
    sessionCreated: false,
    identity: overrides.identity ?? null,
    user: overrides.user ?? null,
    tx: {
      id: 'tx-1',
      nonce_hash: '',
      code_verifier: 'verifier',
      mode: 'login',
      user_id: null,
      issued_session_id: null,
    },
  };
  const db = {
    prepare(query: string) {
      let values: unknown[] = [];
      const statement = {
        query,
        bind(...bound: unknown[]) {
          values = bound;
          return statement;
        },
        async first<T>() {
          if (query.includes('FROM sessions')) return null as T | null;
          if (query.includes('FROM oauth_transactions WHERE provider')) return state.tx as T;
          if (query.includes('FROM auth_identities')) return state.identity as T | null;
          if (query.includes('FROM users WHERE id = ? AND status')) return state.user as T | null;
          if (query.includes('SELECT id FROM users WHERE username')) return null as T | null;
          return null as T | null;
        },
        async all<T>() {
          return { results: [] as T[], success: true };
        },
        async run() {
          if (query.includes('UPDATE oauth_transactions')) state.oauthClaimed = true;
          if (query.includes('INSERT INTO oauth_transactions')) {
            state.oauthInserted = true;
            state.oauthMode = values[4] as OAuthMode;
            state.tx.mode = values[4] as OAuthMode;
            state.tx.code_verifier = values[3] as string;
            state.tx.nonce_hash = values[2] as string;
          }
          if (query.includes('INSERT INTO sessions')) state.sessionCreated = true;
          return {
            success: true,
            meta: { changes: query.includes('UPDATE oauth_transactions') ? 1 : 0 },
          };
        },
      } as unknown as D1PreparedStatement & { query: string };
      return statement;
    },
    async batch(statements: (D1PreparedStatement & { query?: string })[]) {
      state.batchQueries.push(...statements.map((statement) => statement.query ?? ''));
      return statements.map(() => ({ success: true, meta: { changes: 1 } }));
    },
  } as unknown as D1Database;
  const env: Bindings = {
    DB: db,
    APP_ORIGIN: 'http://localhost:3000',
    RP_ID: 'localhost',
    RP_NAME: 'Test',
    BOOTSTRAP_TOKEN: 'bootstrap',
    APP_SESSION_SECRET: SESSION_SECRET,
    TELEGRAM_BOT_TOKENS: '111:token-one',
    TELEGRAM_SHARED_CHANNEL: '@pool',
    GOOGLE_CLIENT_ID: 'client-id',
    GOOGLE_CLIENT_SECRET: 'client-secret',
    GOOGLE_CALLBACK_URL: 'http://worker.test/v1/auth/google/callback',
    GOOGLE_REGISTRATION_SECRET: REGISTRATION_SECRET,
  };
  return { env, state };
}

function startRequest(body: unknown): Request {
  return new Request('http://worker.test/v1/auth/google/start', {
    method: 'POST',
    headers: {
      Origin: 'http://localhost:3000',
      Cookie: 'td_csrf=csrf-token',
      'X-CSRF-Token': 'csrf-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

async function callbackRequest(
  stateSeed: Partial<Pick<State, 'user'>>,
  stateCookie: string,
  mode: OAuthMode,
  identity: State['identity'],
) {
  const { env, state } = environment({ identity, user: stateSeed.user });
  state.tx = {
    id: 'tx-1',
    nonce_hash: await secretHash(NONCE, SESSION_SECRET),
    code_verifier: 'verifier',
    mode,
    user_id: null,
    issued_session_id: null,
  };
  state.identity = identity;
  vi.mocked(jwtVerify).mockResolvedValue({
    payload: {
      iss: 'https://accounts.google.com',
      sub: 'google-subject',
      nonce: NONCE,
      email: 'new-user@example.com',
      name: 'New User',
    },
    protectedHeader: { alg: 'RS256' },
  } as never);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ id_token: 'id-token' })),
  );
  return {
    response: await app.fetch(
      new Request(`http://worker.test/v1/auth/google/callback?state=oauth-state&code=oauth-code`, {
        headers: { Cookie: stateCookie },
      }),
      env,
    ),
    state,
  };
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('Google-only authentication', () => {
  it.each([
    ['missing', {}],
    ['wrong', { secretInfo: 'wrong-secret' }],
    ['oversized', { secretInfo: 'x'.repeat(1025) }],
  ])('denies %s registration secret before creating OAuth transaction', async (_label, fields) => {
    const { env, state } = environment();
    const response = await app.fetch(startRequest({ mode: 'register', ...fields }), env);

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(state.oauthInserted).toBe(false);
  });

  it('accepts correct registration secret and creates new Google account', async () => {
    const { env, state } = environment();
    const start = await app.fetch(startRequest({ mode: 'register', secretInfo: REGISTRATION_SECRET }), env);
    const stateCookie = start.headers.get('Set-Cookie')?.split(';', 1)[0] ?? '';

    expect(start.status).toBe(200);
    expect(state.oauthMode).toBe('register');
    expect(start.headers.get('Set-Cookie')).not.toContain(REGISTRATION_SECRET);
    expect((await start.json()).authorizationUrl).not.toContain(REGISTRATION_SECRET);

    state.tx.nonce_hash = await secretHash(NONCE, SESSION_SECRET);
    vi.mocked(jwtVerify).mockResolvedValue({
      payload: {
        iss: 'https://accounts.google.com',
        sub: 'google-subject',
        nonce: NONCE,
        email: 'new-user@example.com',
        name: 'New User',
      },
      protectedHeader: { alg: 'RS256' },
    } as never);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ id_token: 'id-token' })),
    );
    const callback = await app.fetch(
      new Request(
        'http://worker.test/v1/auth/google/callback?state=' +
          encodeURIComponent(stateCookie.split('=')[1] ?? '') +
          '&code=oauth-code',
        {
          headers: { Cookie: stateCookie },
        },
      ),
      env,
    );

    expect(callback.status).toBe(302);
    expect(state.batchQueries).toEqual(
      expect.arrayContaining([
        expect.stringContaining('INSERT INTO users'),
        expect.stringContaining('INSERT INTO auth_identities'),
        expect.stringContaining('INSERT INTO workspaces'),
      ]),
    );
  });

  it('rejects unknown Google identity during login generically', async () => {
    const { response, state } = await callbackRequest({}, '__Host-td_oauth_state=oauth-state', 'login', null);

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('http://localhost:3000/?error=google_failed');
    expect(state.batchQueries).toHaveLength(0);
    expect(state.sessionCreated).toBe(false);
  });

  it('signs in existing Google identity without registration secret', async () => {
    const { response, state } = await callbackRequest(
      {
        user: { id: 'existing-user', username: 'existing', display_name: 'Existing', status: 'active' },
      },
      '__Host-td_oauth_state=oauth-state',
      'login',
      { user_id: 'existing-user' },
    );

    expect(response.status).toBe(302);
    expect(state.sessionCreated).toBe(true);
    expect(state.batchQueries).toHaveLength(0);
  });

  it('consumes and clears state for provider denial after validating state', async () => {
    const { env, state } = environment();
    const response = await app.fetch(
      new Request('http://worker.test/v1/auth/google/callback?state=oauth-state&error=access_denied', {
        headers: { Cookie: '__Host-td_oauth_state=oauth-state' },
      }),
      env,
    );

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('http://localhost:3000/?error=google_denied');
    expect(state.oauthClaimed).toBe(true);
    expect(response.headers.get('Set-Cookie')).toContain('__Host-td_oauth_state=;');
    expect(response.headers.get('Set-Cookie')).toContain('Max-Age=0');
  });

  it('removes public passkey routes', async () => {
    const { env } = environment();
    for (const path of [
      '/v1/auth/passkey/register/options',
      '/v1/auth/passkey/register/verify',
      '/v1/auth/passkey/authenticate/options',
      '/v1/auth/passkey/authenticate/verify',
    ]) {
      const response = await app.fetch(
        new Request(`http://worker.test${path}`, {
          method: 'GET',
        }),
        env,
      );
      expect(response.status).toBe(404);
    }
  });
});
