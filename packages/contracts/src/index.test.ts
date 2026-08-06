import { describe, expect, it } from 'vitest';
import {
  CHUNK_SIZE,
  MAX_CHUNK_SIZE,
  MIN_CHUNK_SIZE,
  MTPROTO_PART_SIZE,
  assertValidChunkSize,
  isSha256,
  validateStartUploadRequest,
} from './index';

describe('contracts', () => {
  it('keeps protocol and logical chunk sizes within PRD bounds', () => {
    expect(CHUNK_SIZE).toBe(16 * 1024 * 1024);
    expect(MTPROTO_PART_SIZE).toBe(512 * 1024);
    expect(CHUNK_SIZE).toBeGreaterThanOrEqual(MIN_CHUNK_SIZE);
    expect(CHUNK_SIZE).toBeLessThanOrEqual(MAX_CHUNK_SIZE);
  });

  it('validates chunk size and upload request shape', () => {
    expect(() => assertValidChunkSize(7 * 1024 * 1024)).toThrow(RangeError);
    expect(() => assertValidChunkSize(CHUNK_SIZE)).not.toThrow();
    expect(
      validateStartUploadRequest({
        name: 'x',
        size: 0,
        mimeType: '',
        folderId: null,
        lastModified: null,
        partCount: 0,
        idempotencyKey: 'k',
      }),
    ).toEqual([]);
    expect(validateStartUploadRequest({ name: '', size: -1 })).not.toEqual([]);
  });

  it('accepts only lowercase SHA-256 hex', () => {
    expect(isSha256('a'.repeat(64))).toBe(true);
    expect(isSha256('A'.repeat(64))).toBe(false);
    expect(isSha256('short')).toBe(false);
  });
});
