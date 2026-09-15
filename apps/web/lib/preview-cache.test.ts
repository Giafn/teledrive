import { describe, expect, it, vi } from 'vitest';
import { clearPreviews, getPreview, setPreview } from './preview-cache';

function fakeResult(url: string, size = 100) {
  return { url, mime: 'image/jpeg', size, revoke: vi.fn() };
}

describe('preview-cache', () => {
  it('returns cached previews and refreshes recency', () => {
    clearPreviews();
    const first = fakeResult('blob:1');
    setPreview('a', first);
    expect(getPreview('a')).toBe(first);
    expect(first.revoke).not.toHaveBeenCalled();
  });

  it('evicts oldest entries beyond capacity and revokes them', () => {
    clearPreviews();
    const first = fakeResult('blob:1');
    setPreview('first', first);
    for (let index = 0; index < 10; index += 1) setPreview(`k${index}`, fakeResult(`blob:${index}`));
    expect(getPreview('first')).toBeUndefined();
    expect(first.revoke).toHaveBeenCalledOnce();
  });

  it('revokes everything on clear', () => {
    clearPreviews();
    const first = fakeResult('blob:1');
    setPreview('a', first);
    clearPreviews();
    expect(first.revoke).toHaveBeenCalledOnce();
    expect(getPreview('a')).toBeUndefined();
  });
});
