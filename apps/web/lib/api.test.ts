import { describe, expect, it, vi } from 'vitest';
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

  it('fetches storage pool via GET /v1/telegram/pool with cookies and parses response', async () => {
    const calls: Array<{ path: string; init: RequestInit }> = [];
    const client = new MetadataApiClient({
      baseUrl: 'https://api.example.test',
      fetch: async (input, init = {}) => {
        const url = new URL(String(input));
        calls.push({ path: url.pathname, init });
        if (url.pathname === '/v1/auth/csrf') return json({ csrfToken: 'csrf-token' });
        if (url.pathname === '/v1/telegram/pool')
          return json({
            channel: '123',
            botCount: 3,
            ready: true,
            reason: { code: 'READY', message: 'Storage pool is ready' },
          });
        if (url.pathname === '/v1/bot/uploads')
          return json({
            id: 'upload-1',
            objectId: 'object-1',
            status: 'created',
            chunkSize: 8,
            expectedPartCount: 1,
            expiresAt: '2099-01-01',
            file_id: 'hidden',
          });
        if (url.pathname.endsWith('/attempt')) return json({ partNo: 0, status: 'not_started', file_id: 'hidden' });
        if (url.pathname.endsWith('/content')) return new Response(new Uint8Array([1, 2, 3]));
        if (url.pathname.includes('/manifest'))
          return json({
            object: {
              id: 'object-1',
              folderId: 'folder-1',
              name: 'x',
              mime: 'application/octet-stream',
              size: 3,
              sha256: 'a'.repeat(64),
              partCount: 1,
              status: 'completed',
              createdAt: '2099-01-01',
              updatedAt: '2099-01-01',
              file_path: 'hidden',
            },
            parts: [{ partNo: 0, size: 3, sha256: 'a'.repeat(64), file_id: 'hidden' }],
          });
        return json({ partNo: 0, size: 3, sha256: 'a'.repeat(64), file_id: 'hidden' });
      },
    });

    await expect(client.getStoragePool()).resolves.toEqual({
      channel: '123',
      botCount: 3,
      ready: true,
      reason: { code: 'READY', message: 'Storage pool is ready' },
    });

    const poolCall = calls.find(({ path }) => path === '/v1/telegram/pool');
    expect(poolCall).toBeDefined();
    expect(poolCall?.init.method ?? 'GET').toBe('GET');
    expect(poolCall?.init.credentials).toBe('include');
    // No CSRF header for GET pool endpoint
    expect(new Headers(poolCall?.init.headers).has('X-CSRF-Token')).toBe(false);
  });

  it('parses diagnostic storage pool rejection reasons', async () => {
    const client = new MetadataApiClient({
      baseUrl: 'https://api.example.test',
      fetch: async () =>
        json({
          channel: '@pool',
          botCount: 2,
          ready: false,
          reason: {
            code: 'GET_CHAT_API_REJECTION',
            message: 'Telegram getChat API rejected the request (HTTP 400): chat not found',
          },
        }),
    });

    await expect(client.getStoragePool()).resolves.toEqual({
      channel: '@pool',
      botCount: 2,
      ready: false,
      reason: {
        code: 'GET_CHAT_API_REJECTION',
        message: 'Telegram getChat API rejected the request (HTTP 400): chat not found',
      },
    });
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

  it('sends Telegram mode and optional registration secret in POST JSON with cookies and CSRF', async () => {
    const calls: Array<{ path: string; init: RequestInit }> = [];
    const client = new MetadataApiClient({
      baseUrl: 'https://api.example.test',
      fetch: async (input, init = {}) => {
        calls.push({ path: new URL(String(input)).pathname, init });
        if (new URL(String(input)).pathname === '/v1/auth/csrf') return json({ csrfToken: 'csrf-token' });
        return json({ authorizationUrl: 'https://oauth.telegram.org/auth' });
      },
    });

    await expect(client.telegramAuthorizationUrl('register', 'secret-info')).resolves.toBe(
      'https://oauth.telegram.org/auth',
    );

    expect(calls.map(({ path }) => path)).toEqual(['/v1/auth/csrf', '/v1/auth/telegram/start']);
    const request = calls[1].init;
    expect(request.method).toBe('POST');
    expect(request.credentials).toBe('include');
    expect(new Headers(request.headers).get('X-CSRF-Token')).toBe('csrf-token');
    expect(new Headers(request.headers).get('Content-Type')).toBe('application/json');
    expect(JSON.parse(String(request.body))).toEqual({ mode: 'register', secretInfo: 'secret-info' });
  });

  it('selects workspaces and uses owner membership routes', async () => {
    const calls: Array<{ path: string; init: RequestInit }> = [];
    const client = new MetadataApiClient({
      baseUrl: 'https://api.example.test',
      fetch: async (input, init = {}) => {
        const path = new URL(String(input)).pathname;
        calls.push({ path, init });
        if (path === '/v1/auth/csrf') return json({ csrfToken: 'csrf-token' });
        if (path === '/v1/workspaces') return json({ workspaces: [] });
        if (init.method === 'POST') return json({ workspaceId: 'w-1', member: { userId: 'u-1', role: 'member' } });
        if (init.method === 'DELETE') return json({ workspaceId: 'w-1', userId: 'u-1', removed: true });
        return json({ workspaceId: 'w-1', members: [] });
      },
    });
    await expect(client.listWorkspaces()).resolves.toEqual({ workspaces: [] });
    await client.listWorkspaceMembers('w-1');
    await client.addWorkspaceMember('w-1', 'u-1');
    await client.removeWorkspaceMember('w-1', 'u-1');
    expect(calls.map(({ path }) => path)).toEqual([
      '/v1/workspaces', '/v1/workspaces/w-1/members', '/v1/auth/csrf',
      '/v1/workspaces/w-1/members', '/v1/workspaces/w-1/members/u-1',
    ]);
  });

  it('routes workspace export through workspaceId query', async () => {
    let requested = '';
    const client = new MetadataApiClient({
      baseUrl: 'https://api.example.test',
      fetch: async (input) => {
        requested = String(input);
        return json({ exportedAt: '2099-01-01', workspace: { id: 'w-2', name: 'Shared' }, folders: [], objects: [], parts: [] });
      },
    });
    await expect(client.exportWorkspace('w/2')).resolves.toMatchObject({ workspace: { id: 'w-2' } });
    expect(new URL(requested).pathname).toBe('/v1/export');
    expect(new URL(requested).search).toBe('?workspaceId=w%2F2');
  });

  it('forwards upload AbortSignal to fetch fallback', async () => {
    const calls: Array<{ path: string; init: RequestInit }> = [];
    const signal = new AbortController().signal;
    const client = new MetadataApiClient({
      baseUrl: 'https://api.example.test',
      fetch: async (input, init = {}) => {
        calls.push({ path: new URL(String(input)).pathname, init });
        if (new URL(String(input)).pathname === '/v1/auth/csrf') return json({ csrfToken: 'csrf-token' });
        return json({ partNo: 0, size: 1, sha256: 'a'.repeat(64) });
      },
    });

    await expect(
      client.uploadBotPart(
        'upload-1',
        0,
        new Blob([new Uint8Array([1])]),
        { size: 1, sha256: 'a'.repeat(64), idempotencyKey: 'key-1' },
        undefined,
        signal,
      ),
    ).resolves.toEqual({ partNo: 0, size: 1, sha256: 'a'.repeat(64) });
    expect(calls[1].init.signal).toBe(signal);
  });

  it('aborts active XHR upload and reports request cancellation', async () => {
    let resolveCreated: (xhr: PendingUploadXhr) => void = () => undefined;
    const created = new Promise<PendingUploadXhr>((resolve) => {
      resolveCreated = resolve;
    });
    class PendingUploadXhr {
      readonly upload = { onprogress: null as ((event: { loaded: number }) => void) | null };
      readonly status = 200;
      readonly statusText = 'OK';
      readonly responseText = '';
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;
      abortCalls = 0;

      constructor() {
        resolveCreated(this);
      }

      open(): void {}
      setRequestHeader(): void {}
      send(): void {}
      abort(): void {
        this.abortCalls += 1;
        this.onabort?.();
      }
      getAllResponseHeaders(): string {
        return '';
      }
    }

    vi.stubGlobal('XMLHttpRequest', PendingUploadXhr);
    try {
      const controller = new AbortController();
      const removeAbortListener = vi.spyOn(controller.signal, 'removeEventListener');
      let progressCalls = 0;
      const client = new MetadataApiClient({
        baseUrl: 'https://api.example.test',
        fetch: async (input) =>
          new URL(String(input)).pathname === '/v1/auth/csrf'
            ? json({ csrfToken: 'csrf-token' })
            : json({ partNo: 0, size: 1, sha256: 'a'.repeat(64) }),
      });
      const request = client.uploadBotPart(
        'upload-1',
        0,
        new Blob([new Uint8Array([1])]),
        { size: 1, sha256: 'a'.repeat(64), idempotencyKey: 'key-1' },
        () => {
          progressCalls += 1;
        },
        controller.signal,
      );
      const xhr = await created;
      controller.abort();
      await expect(request).rejects.toMatchObject({ code: 'REQUEST_ABORTED', status: 0 });
      expect(xhr.abortCalls).toBe(1);
      expect(removeAbortListener).toHaveBeenCalledWith('abort', expect.any(Function));
      expect(xhr.onload).toBeNull();
      expect(xhr.onerror).toBeNull();
      expect(xhr.onabort).toBeNull();
      expect(xhr.upload.onprogress).toBeNull();
      xhr.upload.onprogress?.({ loaded: 1 });
      expect(progressCalls).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
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
