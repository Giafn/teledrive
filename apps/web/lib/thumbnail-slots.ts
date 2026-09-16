import { DownloadError } from './download-controller';

const MAX_THUMBNAIL_LOADS = 2;
let activeThumbnailLoads = 0;
type ThumbnailWaiter = { resolve: () => void; signal: AbortSignal };
const thumbnailWaiters: ThumbnailWaiter[] = [];

export async function acquireThumbnailSlot(signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new DownloadError('DOWNLOAD_ABORTED', 'Thumbnail loading was aborted.');
  if (activeThumbnailLoads < MAX_THUMBNAIL_LOADS) {
    activeThumbnailLoads += 1;
    return;
  }
  await new Promise<void>((resolve, reject) => {
    let waiter: ThumbnailWaiter;
    const onAbort = () => {
      const index = thumbnailWaiters.indexOf(waiter);
      if (index >= 0) thumbnailWaiters.splice(index, 1);
      reject(new DownloadError('DOWNLOAD_ABORTED', 'Thumbnail loading was aborted.'));
    };
    waiter = {
      resolve: () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      },
      signal,
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    else thumbnailWaiters.push(waiter);
  });
  activeThumbnailLoads += 1;
}

export function releaseThumbnailSlot(): void {
  activeThumbnailLoads = Math.max(0, activeThumbnailLoads - 1);
  while (thumbnailWaiters.length) {
    const waiter = thumbnailWaiters.shift();
    if (!waiter || waiter.signal.aborted) continue;
    waiter.resolve();
    return;
  }
}
