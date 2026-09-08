import { describe, expect, it } from 'vitest';
import {
  MAX_THUMBNAIL_BYTES,
  sameThumbnail,
  thumbnailResponse,
  validateThumbnailInput,
} from '../src/thumbnail';

const validInput = {
  messageId: '123',
  mime: 'image/jpeg',
  size: 1024,
  sha256: 'a'.repeat(64),
};

describe('thumbnail metadata validation', () => {
  it('accepts a valid JPEG reference and normalizes hash casing', () => {
    const result = validateThumbnailInput({ ...validInput, sha256: validInput.sha256.toUpperCase() });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.thumbnail).toEqual(validInput);
    }
  });

  it('accepts WebP references', () => {
    const result = validateThumbnailInput({ ...validInput, mime: 'image/webp' });
    expect(result.valid).toBe(true);
  });

  it('rejects unsupported mime types', () => {
    expect(validateThumbnailInput({ ...validInput, mime: 'image/png' }).valid).toBe(false);
    expect(validateThumbnailInput({ ...validInput, mime: 'application/pdf' }).valid).toBe(false);
    expect(validateThumbnailInput({ ...validInput, mime: '' }).valid).toBe(false);
  });

  it('rejects invalid message IDs', () => {
    expect(validateThumbnailInput({ ...validInput, messageId: '0' }).valid).toBe(false);
    expect(validateThumbnailInput({ ...validInput, messageId: '-4' }).valid).toBe(false);
    expect(validateThumbnailInput({ ...validInput, messageId: 'abc' }).valid).toBe(false);
    expect(validateThumbnailInput({ ...validInput, messageId: '1'.repeat(65) }).valid).toBe(false);
  });

  it('rejects sizes outside the allowed thumbnail budget', () => {
    expect(validateThumbnailInput({ ...validInput, size: 0 }).valid).toBe(false);
    expect(validateThumbnailInput({ ...validInput, size: MAX_THUMBNAIL_BYTES + 1 }).valid).toBe(false);
    expect(validateThumbnailInput({ ...validInput, size: 1.5 }).valid).toBe(false);
    expect(validateThumbnailInput({ ...validInput, size: MAX_THUMBNAIL_BYTES }).valid).toBe(true);
  });

  it('rejects malformed hashes and missing fields', () => {
    expect(validateThumbnailInput({ ...validInput, sha256: 'nothex' }).valid).toBe(false);
    expect(validateThumbnailInput({ ...validInput, sha256: 'g'.repeat(64) }).valid).toBe(false);
    expect(validateThumbnailInput({ messageId: '1', mime: 'image/jpeg', sha256: 'a'.repeat(64) }).valid).toBe(false);
    expect(validateThumbnailInput({}).valid).toBe(false);
  });
});

describe('thumbnail response mapping', () => {
  it('maps complete rows into references', () => {
    expect(
      thumbnailResponse({
        thumbnail_message_id: '42',
        thumbnail_mime: 'image/webp',
        thumbnail_size: 2048,
        thumbnail_sha256: 'b'.repeat(64),
      }),
    ).toEqual({ messageId: '42', mime: 'image/webp', size: 2048, sha256: 'b'.repeat(64) });
  });

  it('returns null for legacy objects or incomplete rows', () => {
    expect(thumbnailResponse(null)).toBeNull();
    expect(
      thumbnailResponse({
        thumbnail_message_id: null,
        thumbnail_mime: null,
        thumbnail_size: null,
        thumbnail_sha256: null,
      }),
    ).toBeNull();
    expect(
      thumbnailResponse({
        thumbnail_message_id: '42',
        thumbnail_mime: 'image/jpeg',
        thumbnail_size: null,
        thumbnail_sha256: 'b'.repeat(64),
      }),
    ).toBeNull();
    expect(
      thumbnailResponse({
        thumbnail_message_id: '42',
        thumbnail_mime: 'video/mp4',
        thumbnail_size: 10,
        thumbnail_sha256: 'b'.repeat(64),
      }),
    ).toBeNull();
  });
});

describe('thumbnail idempotency comparison', () => {
  it('detects identical and differing references', () => {
    const reference = { messageId: '1', mime: 'image/jpeg' as const, size: 10, sha256: 'c'.repeat(64) };
    expect(sameThumbnail(reference, { ...reference })).toBe(true);
    expect(sameThumbnail(reference, { ...reference, size: 11 })).toBe(false);
    expect(sameThumbnail(reference, { ...reference, messageId: '2' })).toBe(false);
  });
});
