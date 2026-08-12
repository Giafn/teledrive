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
const REGISTRATION_SECRET = 'telegram-registration-secret';
const TELEGRAM_ISSUER = 'https://oauth.telegram.org';
let requestIpCounter = 0;

type OAuthMode = 'login' | 'register';
type TokenClaims = {
  iss?: string;
  sub?: string;
  aud?: string | string[];
  nonce?: string;
  exp?: number;
  iat?: number;
};

interface State {
  oauthInserted: boolean;
  oauthClaimed: boolean;
  sessionCreated: boolean;
  batchQueries: string[];
  identity: { user_id: string } | null;
  user: UserRow | null;
  tx: {
    stateHash: string;
    nonce_hash: string;
    code_verifier: string;
    mode: OAuthMode;
    expires_at: string;
    used_at: string | null;
  } | null;
}

function environment(overrides: Partial<Pick<State, 'identity' | 'user'>> = {}): { env: Bindings; state: State } {
  const state: State = {
    oauthInserted: false,
    oauthClaimed: false,
    sessionCreated: false,
    batchQueries: [],
    identity: overrides.identity ?? null,
    user: overrides.user ?? null,
    tx: null,
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
          if (query.includes("FROM oauth_transactions WHERE provider = 'telegram'")) return state.tx as T | null;
          if (query.includes('FROM auth_identities')) return state.identity as T | null;
          if (query.includes('FROM users WHERE id = ? AND status')) return state.user as T | null;
          if (query.includes('SELECT id FROM users WHERE username')) return null as T | null;
          return null as T | null;
        },
        async all<T>() {
          return { results: [] as T[], success: true };
        },
        async run() {
          if (query.includes('DELETE FROM oauth_transactions')) return { success: true, meta: { changes: 0 } };
          if (query.includes('INSERT INTO oauth_transactions')) {
            state.oauthInserted = true;
            state.tx = {
              stateHash: values[1] as string,
              nonce_hash: values[2] as string,
              code_verifier: values[3] as string,
              mode: values[4] as OAuthMode,
              expires_at: values[5] as string,
              used_at: null,
            };
          }
          if (query.includes('UPDATE oauth_transactions')) {
            const tx = state.tx;
            const stateHash = values[1] as string;
            const expiresAt = tx ? Date.parse(tx.expires_at) : 0;
            if (tx && tx.stateHash === stateHash && !tx.used_at && expiresAt > Date.now()) {
              tx.used_at = values[0] as string;
              state.oauthClaimed = true;
              return { success: true, meta: { changes: 1 } };
            }
            return { success: true, meta: { changes: 0 } };
          }
          if (query.includes('INSERT INTO sessions')) state.sessionCreated = true;
          return { success: true, meta: { changes: 1 } };
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
    GOOGLE_REGISTRATION_SECRET: 'google-registration-secret',
    TELEGRAM_LOGIN_CLIENT_ID: 'telegram-client-id',
    TELEGRAM_LOGIN_CLIENT_SECRET: 'telegram-client-secret',
    TELEGRAM_LOGIN_CALLBACK_URL: 'https://worker.test/v1/auth/telegram/callback',
    TELEGRAM_REGISTRATION_SECRET: REGISTRATION_SECRET,
  };
  return { env, state };
}

function startRequest(body: unknown): Request {
  return new Request('http://worker.test/v1/auth/telegram/start', {
    method: 'POST',
    headers: {
      Origin: 'http://localhost:3000',
      Cookie: 'td_csrf=csrf-token',
      'X-CSRF-Token': 'csrf-token',
      'Content-Type': 'application/json',
      'CF-Connecting-IP': `test-${requestIpCounter += 1}`,
    },
    body: JSON.stringify(body),
  });
}

async function begin(
  mode: OAuthMode,
  overrides: Partial<Pick<State, 'identity' | 'user'>> = {},
  fields: Record<string, unknown> = {},
) {
  const { env, state } = environment(overrides);
  const start = await app.fetch(startRequest({ mode, ...fields }), env);
  const stateCookie = start.headers.get('Set-Cookie')?.split(';', 1)[0] ?? '';
  return { env, state, start, stateCookie };
}

function validClaims(overrides: TokenClaims = {}): TokenClaims {
  const current = Math.floor(Date.now() / 1000);
  return {
    iss: TELEGRAM_ISSUER,
    sub: 'telegram-subject',
    aud: 'telegram-client-id',
    nonce: 'test-nonce',
    iat: current - 10,
    exp: current + 600,
    ...overrides,
  };
}

async function callback(
  env: Bindings,
  stateCookie: string,
  claims: TokenClaims = validClaims(),
  algorithm = 'RS256',
  tokenResponse: Response = Response.json({ id_token: 'telegram-id-token' }),
  verificationError?: unknown,
): Promise<Response> {
  if (verificationError === undefined) {
    vi.mocked(jwtVerify).mockResolvedValue({
      payload: claims,
      protectedHeader: { alg: algorithm },
    } as never);
  } else {
    vi.mocked(jwtVerify).mockRejectedValue(verificationError);
  }
  vi.stubGlobal('fetch', vi.fn(async () => tokenResponse));
  return app.fetch(
    new Request('http://worker.test/v1/auth/telegram/callback?state=' + encodeURIComponent(stateCookie.split('=', 2)[1] ?? '') + '&code=telegram-code', {
      headers: { Cookie: stateCookie },
    }),
    env,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function diagnosticEvents(info: { mock: { calls: unknown[][] } }): Record<string, unknown>[] {
  return info.mock.calls.flatMap(([label, payload]) =>
    label === 'telegram_oidc' && payload && typeof payload === 'object' ? [payload as Record<string, unknown>] : [],
  );
}

function expectSafeDiagnostics(info: { mock: { calls: unknown[][] } }, sensitiveValues: string[]): void {
  const serialized = JSON.stringify(info.mock.calls);
  for (const value of sensitiveValues) expect(serialized).not.toContain(value);
  for (const event of diagnosticEvents(info)) {
    expect(event).toEqual(expect.objectContaining({ stage: expect.any(String), result: expect.any(String) }));
    expect(Object.keys(event)).not.toEqual(
      expect.arrayContaining([
        'authorizationCode',
        'code',
        'state',
        'nonce',
        'verifier',
        'token',
        'secret',
        'userId',
        'idToken',
        'accessToken',
        'clientSecret',
        'registrationSecret',
        'payload',
        'message',
        'username',
        'phone',
        'otp',
      ]),
    );
  }
}

describe('Telegram OIDC authentication', () => {
  it('registers new identity with secret, PKCE, opaque names, workspace, and session', async () => {
    const { env, state, start, stateCookie } = await begin('register', {}, { secretInfo: REGISTRATION_SECRET });
    expect(start.status).toBe(200);
    const authorizationUrl = new URL(((await start.json()) as { authorizationUrl: string }).authorizationUrl);
    expect(authorizationUrl.origin).toBe('https://oauth.telegram.org');
    expect(authorizationUrl.pathname).toBe('/auth');
    expect(authorizationUrl.searchParams.get('scope')).toBe('openid');
    expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorizationUrl.searchParams.get('state')).toBe(stateCookie.split('=', 2)[1]);
    expect(authorizationUrl.searchParams.get('nonce')).toBeTruthy();

    state.tx!.nonce_hash = await secretHash('test-nonce', SESSION_SECRET);
    const response = await callback(env, stateCookie);

    expect(response.status).toBe(302);
    expect(state.oauthClaimed).toBe(true);
    expect(state.sessionCreated).toBe(true);
    expect(state.batchQueries).toEqual(
      expect.arrayContaining([
        expect.stringContaining("VALUES (?, ?, 'Telegram User', 'active'"),
        expect.stringContaining("VALUES (?, ?, 'telegram'"),
        expect.stringContaining('INSERT INTO workspaces'),
      ]),
    );
    expect(response.headers.get('Set-Cookie')).toContain('__Host-td_session=');
    expect(response.headers.get('Set-Cookie')).toContain('__Host-td_telegram_oauth_state=;');
  });

  it('logs in existing Telegram identity without registration secret and uses HTTP Basic token auth', async () => {
    const { env, state, stateCookie } = await begin(
      'login',
      {
        identity: { user_id: 'existing-user' },
        user: { id: 'existing-user', username: 'existing', display_name: 'Existing', status: 'active' },
      },
    );
    state.tx!.nonce_hash = await secretHash('test-nonce', SESSION_SECRET);
    const response = await callback(env, stateCookie);

    expect(response.status).toBe(302);
    expect(state.sessionCreated).toBe(true);
    expect(state.batchQueries).toHaveLength(0);
    const request = vi.mocked(fetch).mock.calls[0]?.[1] as RequestInit;
    expect((request.headers as Record<string, string>).Authorization).toBe(
      `Basic ${btoa('telegram-client-id:telegram-client-secret')}`,
    );
    expect((request.headers as Record<string, string>)['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(String(request.body)).toContain('code_verifier=');
    expect(String(request.body)).toContain('redirect_uri=https%3A%2F%2Fworker.test%2Fv1%2Fauth%2Ftelegram%2Fcallback');
    expect(String(request.body)).not.toContain('telegram-client-secret');
  });

  it.each([
    ['missing', {}],
    ['wrong', { secretInfo: 'wrong-secret' }],
    ['oversized', { secretInfo: 'x'.repeat(1025) }],
  ])('rejects %s registration secret before creating transaction', async (_label, fields) => {
    const { start, state } = await begin('register', {}, fields);
    expect(start.status).toBeGreaterThanOrEqual(400);
    expect(state.oauthInserted).toBe(false);
  });

  it('rejects replayed callback after consuming transaction', async () => {
    const { env, state, stateCookie } = await begin('login', {
      identity: { user_id: 'existing-user' },
      user: { id: 'existing-user', username: 'existing', display_name: 'Existing', status: 'active' },
    });
    state.tx!.nonce_hash = await secretHash('test-nonce', SESSION_SECRET);
    const firstResponse = await callback(env, stateCookie);
    const secondResponse = await callback(env, stateCookie);

    expect(firstResponse.status).toBe(302);
    expect(secondResponse.headers.get('Location')).toBe('http://localhost:3000/?error=telegram_failed');
    expect(state.oauthClaimed).toBe(true);
  });

  it('diagnoses callback state failures without logging callback secrets', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const { env } = await begin('login');
    const response = await app.fetch(
      new Request('http://worker.test/v1/auth/telegram/callback?state=wrong-state&code=telegram-code', {
        headers: { Cookie: '__Host-td_telegram_oauth_state=actual-state' },
      }),
      env,
    );

    expect(response.headers.get('Location')).toBe('http://localhost:3000/?error=telegram_failed');
    expect(diagnosticEvents(info)).toContainEqual({ stage: 'callback_state', result: 'state_mismatch' });
    expectSafeDiagnostics(info, ['wrong-state', 'actual-state', 'telegram-code', REGISTRATION_SECRET]);
  });

  it('diagnoses token exchange invalid JSON with status class and safe fields', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const { env, state, stateCookie } = await begin('login');
    state.tx!.nonce_hash = await secretHash('test-nonce', SESSION_SECRET);
    const response = await callback(env, stateCookie, validClaims(), 'RS256', new Response('sensitive-payload', { status: 502 }));

    expect(response.headers.get('Location')).toBe('http://localhost:3000/?error=telegram_failed');
    expect(diagnosticEvents(info)).toContainEqual({ stage: 'token_exchange', result: 'invalid_json', statusClass: '5xx' });
    expectSafeDiagnostics(info, ['sensitive-payload', 'telegram-code', 'test-nonce', 'telegram-id-token']);
  });

  it('diagnoses JWT header and verification class without serializing token or error', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const header = btoa(JSON.stringify({ alg: 'RS256', kid: 'telegram-key-1' }))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replaceAll('=', '');
    const idToken = `${header}.payload.signature`;
    const { env, state, stateCookie } = await begin('login');
    state.tx!.nonce_hash = await secretHash('test-nonce', SESSION_SECRET);
    const response = await callback(
      env,
      stateCookie,
      validClaims(),
      'RS256',
      Response.json({ id_token: idToken }),
      new Error('sensitive-verification-error'),
    );

    expect(response.headers.get('Location')).toBe('http://localhost:3000/?error=telegram_failed');
    expect(diagnosticEvents(info)).toContainEqual({
      stage: 'jwt_header',
      result: 'observed',
      alg: 'RS256',
      kid: 'telegram-key-1',
    });
    expect(diagnosticEvents(info)).toContainEqual({ stage: 'verification', result: 'failed', errorClass: 'Error' });
    expectSafeDiagnostics(info, [idToken, 'sensitive-verification-error', 'telegram-code', 'test-nonce']);
  });

  it('rejects expired callback transaction', async () => {
    const { env, state, stateCookie } = await begin('login', {
      identity: { user_id: 'existing-user' },
      user: { id: 'existing-user', username: 'existing', display_name: 'Existing', status: 'active' },
    });
    state.tx!.expires_at = '2000-01-01T00:00:00.000Z';
    const response = await callback(env, stateCookie);

    expect(response.headers.get('Location')).toBe('http://localhost:3000/?error=telegram_failed');
    expect(state.oauthClaimed).toBe(false);
    expect(state.sessionCreated).toBe(false);
  });

  it.each([
    ['nonce', { nonce: 'wrong-nonce' }],
    ['issuer', { iss: 'https://evil.example' }],
    ['audience', { aud: 'wrong-client-id' }],
    ['expired', { exp: Math.floor(Date.now() / 1000) - 120 }],
    ['future-issued', { iat: Math.floor(Date.now() / 1000) + 120 }],
  ])('rejects invalid %s token claim', async (_label, claims) => {
    const { env, state, stateCookie } = await begin('login', {
      identity: { user_id: 'existing-user' },
      user: { id: 'existing-user', username: 'existing', display_name: 'Existing', status: 'active' },
    });
    state.tx!.nonce_hash = await secretHash('test-nonce', SESSION_SECRET);
    const response = await callback(env, stateCookie, validClaims(claims));

    expect(response.headers.get('Location')).toBe('http://localhost:3000/?error=telegram_failed');
    expect(state.sessionCreated).toBe(false);
  });

  it('categorizes claim mismatch without logging claim values', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const { env, state, stateCookie } = await begin('login', {
      identity: { user_id: 'existing-user' },
      user: { id: 'existing-user', username: 'existing', display_name: 'Existing', status: 'active' },
    });
    state.tx!.nonce_hash = await secretHash('test-nonce', SESSION_SECRET);
    const response = await callback(env, stateCookie, validClaims({ nonce: 'wrong-nonce' }));

    expect(response.headers.get('Location')).toBe('http://localhost:3000/?error=telegram_failed');
    expect(diagnosticEvents(info)).toContainEqual({ stage: 'claims', result: 'mismatch', category: 'nonce' });
    expectSafeDiagnostics(info, ['wrong-nonce', 'test-nonce', 'existing-user', 'existing', 'telegram-subject']);
  });

  it('rejects unsupported JWT algorithm', async () => {
    const { env, state, stateCookie } = await begin('login', {
      identity: { user_id: 'existing-user' },
      user: { id: 'existing-user', username: 'existing', display_name: 'Existing', status: 'active' },
    });
    state.tx!.nonce_hash = await secretHash('test-nonce', SESSION_SECRET);
    const response = await callback(env, stateCookie, validClaims(), 'HS256');

    expect(response.headers.get('Location')).toBe('http://localhost:3000/?error=telegram_failed');
    expect(state.sessionCreated).toBe(false);
  });

  it('rejects unknown Telegram identity during login', async () => {
    const { env, state, stateCookie } = await begin('login');
    state.tx!.nonce_hash = await secretHash('test-nonce', SESSION_SECRET);
    const response = await callback(env, stateCookie);

    expect(response.headers.get('Location')).toBe('http://localhost:3000/?error=telegram_failed');
    expect(state.sessionCreated).toBe(false);
    expect(state.batchQueries).toHaveLength(0);
  });

  it('diagnoses missing identity and preserves generic redirect', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const { env, state, stateCookie } = await begin('login');
    state.tx!.nonce_hash = await secretHash('test-nonce', SESSION_SECRET);
    const response = await callback(env, stateCookie);

    expect(response.headers.get('Location')).toBe('http://localhost:3000/?error=telegram_failed');
    expect(diagnosticEvents(info)).toContainEqual({ stage: 'identity_persistence', result: 'missing' });
    expect(diagnosticEvents(info)).toContainEqual({ stage: 'identity_persistence', result: 'login_identity_missing' });
    expectSafeDiagnostics(info, ['telegram-subject', 'telegram-id-token', 'test-nonce', 'telegram-code']);
  });
});
