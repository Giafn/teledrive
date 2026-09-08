import { describe, expect, it } from 'vitest';
import { createMediaThumbnail } from './media-thumbnail';

describe('createMediaThumbnail', () => {
  it('marks non-media files as unsupported without touching the DOM', async () => {
    const file = new File([new Uint8Array([1, 2, 3])], 'notes.txt', { type: 'text/plain' });
    await expect(createMediaThumbnail(file)).resolves.toEqual({ status: 'unsupported' });
  });

  it('reports unsupported outside browser environments even for media files', async () => {
    const file = new File([new Uint8Array([1, 2, 3])], 'clip.mp4', { type: 'video/mp4' });
    await expect(createMediaThumbnail(file)).resolves.toEqual({ status: 'unsupported' });
  });
});
