import { describe, expect, it } from 'vitest';
import { canAbort, canCommitPart, canComplete } from '../src/upload-state';

describe('upload state invariants', () => {
  const future = '2099-01-01T00:00:00.000Z';
  const now = '2026-08-05T00:00:00.000Z';

  it('allows metadata mutations only while upload and object are open', () => {
    expect(canCommitPart('uploading', 'uploading', null, future, now)).toBe(true);
    expect(canCommitPart('completed', 'completed', null, future, now)).toBe(false);
    expect(canComplete('uploading', 'deleted', '2026-08-04T00:00:00.000Z', future, now)).toBe(false);
  });

  it('does not let abort compete with terminal state', () => {
    expect(canAbort('uploading', 'uploading', null)).toBe(true);
    expect(canAbort('completed', 'completed', null)).toBe(false);
    expect(canAbort('uploading', 'uploading', '2026-08-04T00:00:00.000Z')).toBe(false);
  });
});
