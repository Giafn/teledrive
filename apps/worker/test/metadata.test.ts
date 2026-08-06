import { describe, expect, it } from 'vitest';
import {
  canEditObject,
  compareRecentMetadata,
  decodeMetadataCursor,
  encodeMetadataCursor,
  retentionUntil,
  TRASH_RETENTION_DAYS,
} from '../src/metadata';

describe('metadata listing and mutation policy', () => {
  it('round-trips stable cursors and retention', () => {
    const cursor = {
      sortAt: '2026-08-05T00:00:00.000Z',
      secondaryAt: '2026-08-04T00:00:00.000Z',
      kind: 'object',
      id: 'o1',
    };
    expect(decodeMetadataCursor(encodeMetadataCursor(cursor))).toEqual(cursor);
    expect(retentionUntil('2026-08-05T00:00:00.000Z')).toBe('2026-09-04T00:00:00.000Z');
    expect(TRASH_RETENTION_DAYS).toBe(30);
  });

  it('keeps recent ordering stable and rejects unsafe object edits', () => {
    expect(
      compareRecentMetadata(
        { updatedAt: '2026-08-05T00:00:00.000Z', createdAt: '2026-08-01T00:00:00.000Z', id: 'a' },
        { updatedAt: '2026-08-05T00:00:00.000Z', createdAt: '2026-08-01T00:00:00.000Z', id: 'b' },
      ),
    ).toBeLessThan(0);
    expect(canEditObject(true, 'completed', null, true, true)).toBe(true);
    expect(canEditObject(true, 'deleted', null, true, true)).toBe(false);
    expect(canEditObject(false, 'completed', null, true, true)).toBe(false);
    expect(canEditObject(true, 'completed', null, true, false)).toBe(false);
  });
});
