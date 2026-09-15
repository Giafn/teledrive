import type { PreviewResult } from './download-controller';

const MAX_ENTRIES = 10;
const MAX_BYTES = 50 * 1024 * 1024;

type Entry = { result: PreviewResult; size: number };

const entries = new Map<string, Entry>();
let totalBytes = 0;

function evictOldest(): void {
  const oldest = entries.keys().next().value;
  if (oldest === undefined) return;
  const entry = entries.get(oldest);
  if (entry) {
    totalBytes -= entry.size;
    try {
      entry.result.revoke();
    } catch {
      // Revoke best-effort; entri tetap dikeluarkan dari cache.
    }
  }
  entries.delete(oldest);
}

export function getPreview(objectId: string): PreviewResult | undefined {
  const entry = entries.get(objectId);
  if (!entry) return undefined;
  entries.delete(objectId);
  entries.set(objectId, entry);
  return entry.result;
}

export function setPreview(objectId: string, result: PreviewResult): void {
  const existing = entries.get(objectId);
  if (existing) {
    totalBytes -= existing.size;
    entries.delete(objectId);
  }
  entries.set(objectId, { result, size: result.size });
  totalBytes += result.size;
  while ((entries.size > MAX_ENTRIES || totalBytes > MAX_BYTES) && entries.size > 0) evictOldest();
}

export function clearPreviews(): void {
  for (const entry of entries.values()) {
    try {
      entry.result.revoke();
    } catch {
      // Abaikan kegagalan revoke saat pembersihan.
    }
  }
  entries.clear();
  totalBytes = 0;
}
