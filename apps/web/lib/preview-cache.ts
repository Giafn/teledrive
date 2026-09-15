import type { PreviewResult } from './download-controller';

const MAX_ENTRIES = 10;
const MAX_BYTES = 50 * 1024 * 1024;

type Entry = { result: PreviewResult; size: number; pinned: number };

const entries = new Map<string, Entry>();
let totalBytes = 0;

function destroy(entry: Entry): void {
  try {
    entry.result.revoke();
  } catch {
    // Revoke best-effort; entri tetap dikeluarkan dari cache.
  }
}

function evictOldest(): void {
  for (const [key, entry] of entries) {
    if (entry.pinned === 0) {
      totalBytes -= entry.size;
      destroy(entry);
      entries.delete(key);
      return;
    }
  }
}

export function getPreview(objectId: string): PreviewResult | undefined {
  const entry = entries.get(objectId);
  if (!entry) return undefined;
  entries.delete(objectId);
  entries.set(objectId, entry);
  entry.pinned += 1;
  return entry.result;
}

export function releasePreview(objectId: string): void {
  const entry = entries.get(objectId);
  if (!entry || entry.pinned === 0) return;
  entry.pinned -= 1;
}

export function setPreview(objectId: string, result: PreviewResult): void {
  const existing = entries.get(objectId);
  if (existing) {
    totalBytes -= existing.size;
    entries.delete(objectId);
    if (existing.pinned > 0) destroy(existing);
  }
  entries.set(objectId, { result, size: result.size, pinned: 0 });
  totalBytes += result.size;
  while ((entries.size > MAX_ENTRIES || totalBytes > MAX_BYTES) && entries.size > 0) {
    const before = entries.size;
    evictOldest();
    if (entries.size === before) break;
  }
}

export function clearPreviews(): void {
  for (const entry of entries.values()) destroy(entry);
  entries.clear();
  totalBytes = 0;
}
