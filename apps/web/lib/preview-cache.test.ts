import { describe, expect, it, vi } from 'vitest';
import { clearPreviews, getPreviewBytes, PREVIEW_BYTES_TTL_MS, setPreviewBytes } from './preview-cache';

describe('preview-cache', () => {
  it('returns cached bytes and refreshes recency', () => {
    clearPreviews();
    const bytes = new Uint8Array([1, 2, 3]);
    setPreviewBytes('a', bytes, 'image/jpeg');
    const hit = getPreviewBytes('a');
    expect(hit?.bytes).toBe(bytes);
    expect(hit?.mime).toBe('image/jpeg');
  });

  it('evicts oldest entries beyond capacity without revoke callbacks', () => {
    clearPreviews();
    setPreviewBytes('first', new Uint8Array([1]), 'image/jpeg');
    for (let index = 0; index < 10; index += 1) setPreviewBytes(`k${index}`, new Uint8Array([2]), 'image/jpeg');
    expect(getPreviewBytes('first')).toBeUndefined();
  });

  it('expires entries after TTL', () => {
    clearPreviews();
    setPreviewBytes('a', new Uint8Array([1]), 'image/jpeg');
    const now = Date.now();
    const spy = vi.spyOn(Date, 'now').mockReturnValue(now + PREVIEW_BYTES_TTL_MS + 1);
    try {
      expect(getPreviewBytes('a')).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  it('rejects oversized payloads and clears everything', () => {
    clearPreviews();
    setPreviewBytes('big', new Uint8Array(6 * 1024 * 1024), 'image/jpeg');
    expect(getPreviewBytes('big')).toBeUndefined();
    setPreviewBytes('a', new Uint8Array([1]), 'image/jpeg');
    clearPreviews();
    expect(getPreviewBytes('a')).toBeUndefined();
  });
});
