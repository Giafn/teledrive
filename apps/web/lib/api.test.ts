import { describe, expect, it } from 'vitest';
import { ApiError, MetadataApiClient } from './api';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('MetadataApiClient object and listing methods', () => {
  it('uses exact paths, pagination, JSON, cookies, and CSRF for mutations', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = new MetadataApiClient({
      baseUrl: 'https://api.example.test/',
      fetch: async (input, init = {}) => {
        const url = String(input);
        calls.push({ url, init });
        if (new URL(url).pathname === '/v1/auth/csrf') return json({ csrfToken: 'csrf-token' });
        if (new URL(url).pathname === '/v1/objects/recent' || new URL(url).pathname === '/v1/trash')
          return json({ items: [], nextCursor: null });
        if (init.method === 'PATCH') return json({ id: 'object-1', name: 'renamed', folderId: 'folder-1' });
        return json({ ok: true, deleted: true, restored: true });
      },
    });

    await client.listRecent({ limit: 20, cursor: 'recent-cursor' });
    await client.listTrash({ limit: 10 });
    await client.updateObject('object-1', { name: 'renamed', folderId: 'folder-1' });
    await client.softDeleteObject('object-1');
    await client.restoreObject('object-1');
    await client.permanentDeleteObject('object-1');
    await client.softDeleteFolder('folder-1');
    await client.restoreFolder('folder-1');
    await client.permanentDeleteFolder('folder-1');

    expect(new URL(calls[0].url).pathname).toBe('/v1/objects/recent');
    expect(new URL(calls[0].url).search).toBe('?limit=20&cursor=recent-cursor');
    expect(new URL(calls[1].url).pathname).toBe('/v1/trash');
    expect(new URL(calls[1].url).search).toBe('?limit=10');
    expect(calls.map(({ init }) => init.method ?? 'GET')).toEqual([
      'GET',
      'GET',
      'GET',
      'PATCH',
      'DELETE',
      'POST',
      'DELETE',
      'DELETE',
      'POST',
      'DELETE',
    ]);

    const mutations = calls.slice(3);
    expect(
      mutations.every(
        ({ init }) => init.credentials === 'include' && new Headers(init.headers).get('X-CSRF-Token') === 'csrf-token',
      ),
    ).toBe(true);
    expect(JSON.parse(String(mutations[0].init.body))).toEqual({ name: 'renamed', folderId: 'folder-1' });
  });

  it('commits thumbnail sidecar references through PUT with CSRF and a typed body', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = new MetadataApiClient({
      baseUrl: 'https://api.example.test',
      fetch: async (input, init = {}) => {
        calls.push({ url: String(input), init });
        if (new URL(String(input)).pathname === '/v1/auth/csrf') return json({ csrfToken: 'csrf-token' });
        return json({
          ok: true,
          idempotent: false,
          thumbnail: { messageId: '42', mime: 'image/jpeg', size: 1024, sha256: 'a'.repeat(64) },
        });
      },
    });
    const input = { messageId: '42', mime: 'image/jpeg' as const, size: 1024, sha256: 'a'.repeat(64) };

    await expect(client.setObjectThumbnail('object-1', input)).resolves.toMatchObject({ ok: true, idempotent: false });

    expect(new URL(calls[1].url).pathname).toBe('/v1/objects/object-1/thumbnail');
    expect(calls[1].init.method).toBe('PUT');
    expect(calls[1].init.credentials).toBe('include');
    expect(new Headers(calls[1].init.headers).get('X-CSRF-Token')).toBe('csrf-token');
    expect(JSON.parse(String(calls[1].init.body))).toEqual(input);
  });

  it('updates folders through the typed PATCH route with CSRF, cookies, and JSON body', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = new MetadataApiClient({
      baseUrl: 'https://api.example.test/',
      fetch: async (input, init = {}) => {
        const url = String(input);
        calls.push({ url, init });
        if (new URL(url).pathname === '/v1/auth/csrf') return json({ csrfToken: 'csrf-token' });
        return json({ id: 'folder-1', name: 'Renamed', parentId: null });
      },
    });

    await expect(client.updateFolder('folder/1', { name: 'Renamed', parentId: null })).resolves.toEqual({
      id: 'folder-1',
      name: 'Renamed',
      parentId: null,
    });

    expect(new URL(calls[0].url).pathname).toBe('/v1/auth/csrf');
    expect(new URL(calls[1].url).pathname).toBe('/v1/folders/folder%2F1');
    expect(calls[1].init.method).toBe('PATCH');
    expect(calls[1].init.credentials).toBe('include');
    expect(new Headers(calls[1].init.headers).get('Content-Type')).toBe('application/json');
    expect(new Headers(calls[1].init.headers).get('X-CSRF-Token')).toBe('csrf-token');
    expect(JSON.parse(String(calls[1].init.body))).toEqual({ name: 'Renamed', parentId: null });
  });

  it('gets current session with cookies and without CSRF', async () => {
    const calls: Array<{ path: string; init: RequestInit }> = [];
    const client = new MetadataApiClient({
      baseUrl: 'https://api.example.test',
      fetch: async (input, init = {}) => {
        calls.push({ path: new URL(String(input)).pathname, init });
        return json({ user: { id: 'user-1', username: 'andi', displayName: 'Andi' } });
      },
    });

    await expect(client.getCurrentSession()).resolves.toEqual({ id: 'user-1', username: 'andi', displayName: 'Andi' });
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe('/v1/auth/session');
    expect(calls[0].init.method ?? 'GET').toBe('GET');
    expect(calls[0].init.credentials).toBe('include');
    expect(new Headers(calls[0].init.headers).has('X-CSRF-Token')).toBe(false);
  });

  it('keeps server error fields but does not expose unrelated response data', async () => {
    const client = new MetadataApiClient({
      baseUrl: 'https://api.example.test',
      fetch: async (input) =>
        new URL(String(input)).pathname === '/v1/auth/csrf'
          ? json({ csrfToken: 'csrf-token' })
          : json(
              {
                error: { code: 'OBJECT_STATE_CHANGED', message: 'retry', requestId: 'request-1' },
                secret: 'must-not-escape',
              },
              409,
            ),
    });

    await expect(client.softDeleteObject('object-1')).rejects.toMatchObject({
      code: 'OBJECT_STATE_CHANGED',
      message: 'retry',
      status: 409,
      requestId: 'request-1',
    });
    try {
      await client.softDeleteObject('object-1');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect(String(error)).not.toContain('must-not-escape');
    }
  });
});
