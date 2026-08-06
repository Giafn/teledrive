import { describe, expect, it } from 'vitest';
import { prepareBootstrapPasskeyStatement } from '../src/index';
import type { D1Database, D1PreparedStatement } from '../src/types';

describe('bootstrap passkey statement', () => {
  it('binds exactly one value per SQL placeholder', () => {
    let query = '';
    let values: unknown[] = [];
    const statement = {
      bind(...bound: unknown[]) {
        values = bound;
        return statement;
      },
    } as unknown as D1PreparedStatement;
    const db = {
      prepare(sql: string) {
        query = sql;
        return statement;
      },
    } as D1Database;
    const publicKey = new Uint8Array([1, 2, 3]);

    prepareBootstrapPasskeyStatement(db, 'credential', publicKey, 7, '[]', 'created', 'user');

    expect((query.match(/\?/gu) ?? []).length).toBe(values.length);
    expect(values).toEqual(['credential', publicKey, 7, '[]', 'created', 'user']);
  });
});
