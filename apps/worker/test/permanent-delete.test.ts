import { describe, expect, it } from 'vitest';
import app from '../src/index';
import { secretHash } from '../src/security';
import type { Bindings, D1Database, D1PreparedStatement } from '../src/types';

const secret = 'test-session-secret';

describe('DELETE /v1/objects/:id/permanent', () => {
  it('accepts cascade deletes affecting multiple rows', async () => {
    let auditRuns = 0;
    const session = {
      session_id: 'session-1',
      csrf_hash: await secretHash('csrf-token', secret),
      expires_at: '2099-01-01T00:00:00.000Z',
      id: 'user-1',
      username: 'alice',
      display_name: 'Alice',
      status: 'active',
    };
    const object = {
      id: 'object-1',
      workspace_id: 'workspace-1',
      folder_id: 'folder-1',
      name: 'file.txt',
      mime: 'text/plain',
      size: 3,
      sha256: null,
      part_count: 1,
      status: 'deleted',
      deleted_at: '2026-01-01T00:00:00.000Z',
      created_at: '2025-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    };
    const db = {
      prepare(query: string) {
        const statement = {
          bind(..._values: unknown[]) {
            return statement;
          },
          async first<T>() {
            if (query.includes('FROM sessions')) return session as T;
            if (query.includes('FROM objects')) return object as T;
            throw new Error(`Unexpected first query: ${query}`);
          },
          async all<T>() {
            return { results: [] as T[], success: true };
          },
          async run() {
            if (query.startsWith('DELETE FROM objects')) return { success: true, meta: { changes: 3 } };
            if (query.startsWith('INSERT INTO audit_events')) {
              auditRuns += 1;
              return { success: true, meta: { changes: 1 } };
            }
            throw new Error(`Unexpected run query: ${query}`);
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
      BOOTSTRAP_TOKEN: 'bootstrap',
      APP_SESSION_SECRET: secret,
      TELEGRAM_WEBHOOK_SECRET: 'webhook',
    };

    const response = await app.fetch(
      new Request('http://worker.test/v1/objects/object-1/permanent', {
        method: 'DELETE',
        headers: {
          Origin: 'http://localhost:3000',
          Cookie: '__Host-td_session=opaque-session-token',
          'X-CSRF-Token': 'csrf-token',
        },
      }),
      env,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(auditRuns).toBe(1);
  });
});
