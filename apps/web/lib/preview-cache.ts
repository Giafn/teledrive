export type CachedPreviewBytes = { bytes: Uint8Array; mime: string; size: number; storedAt: number };

const MAX_ENTRIES = 10;
const MAX_BYTES = 5 * 1024 * 1024;
export const PREVIEW_BYTES_TTL_MS = 60 * 1000;

const entries = new Map<string, CachedPreviewBytes>();
let totalBytes = 0;

export function getPreviewBytes(objectId: string): CachedPreviewBytes | undefined {
  const entry = entries.get(objectId);
  if (!entry) return undefined;
  if (Date.now() - entry.storedAt > PREVIEW_BYTES_TTL_MS) {
    totalBytes -= entry.size;
    entries.delete(objectId);
    return undefined;
  }
  entries.delete(objectId);
  entries.set(objectId, entry);
  return entry;
}

export function setPreviewBytes(objectId: string, bytes: Uint8Array, mime: string): void {
  if (bytes.byteLength > MAX_BYTES) return;
  const existing = entries.get(objectId);
  if (existing) {
    totalBytes -= existing.size;
    entries.delete(objectId);
  }
  entries.set(objectId, { bytes, mime, size: bytes.byteLength, storedAt: Date.now() });
  totalBytes += bytes.byteLength;
  while ((entries.size > MAX_ENTRIES || totalBytes > MAX_BYTES) && entries.size > 0) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) break;
    const entry = entries.get(oldest);
    if (entry) totalBytes -= entry.size;
    entries.delete(oldest);
  }
}

export function clearPreviews(): void {
  entries.clear();
  totalBytes = 0;
}
