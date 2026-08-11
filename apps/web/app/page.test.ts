import { describe, expect, it } from 'vitest';
import { MetadataApiClient } from '../lib/api';
import { requestTelegramAuthorization } from '../lib/ui-actions';

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('Telegram authorization action', () => {
  it.each([
    ['login', undefined],
    ['register', 'registration-secret'],
  ] as const)('executes %s through MetadataApiClient receiver', async (mode, secretInfo) => {
    const requests: Request[] = [];
    const client = new MetadataApiClient({
      baseUrl: 'https://api.example.test',
      fetch: async (input, init) => {
        requests.push(new Request(String(input), init));
        return requests.at(-1)?.url.endsWith('/v1/auth/csrf')
          ? json({ csrfToken: 'csrf-token' })
          : json({ authorizationUrl: 'https://oauth.telegram.org/auth' });
      },
    });

    await expect(requestTelegramAuthorization(client, mode, secretInfo)).resolves.toBe(
      'https://oauth.telegram.org/auth',
    );
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      '/v1/auth/csrf',
      '/v1/auth/telegram/start',
    ]);
    expect(JSON.parse(await requests[1].text())).toEqual({
      mode,
      ...(secretInfo === undefined ? {} : { secretInfo }),
    });
  });
});
