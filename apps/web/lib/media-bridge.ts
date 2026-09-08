import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { ManifestResponse } from './api';
import { telegramGateway } from './telegram-gateway';
import type { MediaManifest, MediaManifestPart } from './media-range';

const MAX_INFLIGHT_PARTS = 2;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 100;

/** Video di atas ambang ini (atau multi-part) diputar via Service Worker streaming. */
export const VIDEO_PROXY_MIN_BYTES = 32 * 1024 * 1024;

let registrationPromise: Promise<ServiceWorker> | undefined;
let handlerRegistered = false;
let sleep = defaultSleep;

const manifestCache = new Map<string, MediaManifest>();
const preloaded = new Map<string, Uint8Array>();
const inflight = new Map<string, Promise<Uint8Array>>();
const waiters: Array<() => void> = [];
let activeCount = 0;

type PortLike = {
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

export type MediaStream = { url: string; close: () => void };

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Test-only: ganti penundaan retry supaya unit test tidak menunggu backoff nyata. */
export function setSleepFunction(fn: (milliseconds: number) => Promise<void>): void {
  sleep = fn;
}

function configuredChannel(): string {
  const channel = process.env.NEXT_PUBLIC_TELEGRAM_CHANNEL;
  if (!channel?.trim()) throw new Error('NEXT_PUBLIC_TELEGRAM_CHANNEL is not configured');
  return channel;
}

function floodWaitSeconds(error: unknown): number | undefined {
  const text = error instanceof Error ? error.message : String(error);
  const match = /\bFLOOD_WAIT_(\d+)\b/i.exec(text);
  if (!match) return undefined;
  const seconds = Number(match[1]);
  return Number.isSafeInteger(seconds) ? seconds : undefined;
}

async function acquireSlot(): Promise<void> {
  if (activeCount < MAX_INFLIGHT_PARTS) {
    activeCount += 1;
    return;
  }
  await new Promise<void>((resolve) => waiters.push(resolve));
  activeCount += 1;
}

function releaseSlot(): void {
  activeCount = Math.max(0, activeCount - 1);
  waiters.shift()?.();
}

export function buildMediaManifest(manifest: ManifestResponse): MediaManifest {
  const parts: MediaManifestPart[] = [...manifest.parts]
    .sort((left, right) => left.partNo - right.partNo)
    .map((part) => ({ partNo: part.partNo, messageId: part.messageId, sha256: part.sha256, size: part.size }));
  if (parts.length === 0) throw new Error('Manifest has no parts');
  return {
    objectId: manifest.object.id,
    mime: manifest.object.mime,
    size: manifest.object.size,
    chunkSize: parts[0].size,
    parts,
  };
}

export function ensureMediaStream(): Promise<ServiceWorker> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return Promise.reject(new Error('Media streaming requires a browser with Service Worker support.'));
  }
  // Harus SW scope root: SW hanya mencegat fetch dari halaman yang ia kontrol,
  // dan halaman aplikasi berada di "/" — scope /media/ tidak akan pernah kena.
  registrationPromise ??= navigator.serviceWorker
    .register('/sw.js', { scope: '/' })
    .then(async (registration) => {
      registerPageMessageHandler();
      // Bersihkan registrasi SW /media/ lama (percobaan pertama) yang tak pernah mengontrol halaman.
      const registrations = await navigator.serviceWorker.getRegistrations();
      for (const reg of registrations) {
        if (new URL(reg.scope).pathname === '/media/') void reg.unregister();
      }
      if (registration.active) return registration.active;
      const worker = registration.installing || registration.waiting;
      if (!worker) throw new Error('Media Service Worker is not activating.');
      return new Promise<ServiceWorker>((resolve, reject) => {
        worker.addEventListener('statechange', () => {
          if (worker.state === 'activated' && registration.active) resolve(registration.active);
          if (worker.state === 'redundant') reject(new Error('Media Service Worker was replaced.'));
        });
      });
    })
    .catch((error) => {
      registrationPromise = undefined;
      throw error;
    });
  return registrationPromise;
}

function registerPageMessageHandler(): void {
  if (handlerRegistered) return;
  handlerRegistered = true;
  navigator.serviceWorker.addEventListener('message', (event) => {
    const data = (event.data ?? {}) as { type?: string; objectId?: unknown; partNo?: unknown };
    const port = event.ports[0] as PortLike | undefined;
    if (data.type === 'td-media-part' && port) {
      void handlePartRequest(port, String(data.objectId), Number(data.partNo));
      return;
    }
    if (data.type === 'td-media-manifest-request' && port) {
      const manifest = manifestCache.get(String(data.objectId));
      port.postMessage(manifest ? { ok: true, manifest } : { ok: false });
    }
  });
}

export async function openMediaStream(manifest: MediaManifest): Promise<MediaStream> {
  const worker = await ensureMediaStream();
  manifestCache.set(manifest.objectId, manifest);
  worker.postMessage({ type: 'td-media-manifest', manifest });
  return {
    url: `/media/stream/${encodeURIComponent(manifest.objectId)}`,
    close: () => worker.postMessage({ type: 'td-media-close', objectId: manifest.objectId }),
  };
}

async function fetchPartBytes(manifest: MediaManifest, part: MediaManifestPart): Promise<Uint8Array> {
  const key = `${manifest.objectId}:${part.partNo}`;
  const existing = inflight.get(key);
  if (existing) return existing;
  const promise = (async () => {
    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
      try {
        const result = await telegramGateway.downloadPart(configuredChannel(), Number(part.messageId));
        if (!(result.data instanceof Uint8Array) || result.data.byteLength !== part.size) {
          throw new Error('PART_SIZE_MISMATCH');
        }
        if (bytesToHex(sha256(result.data)).toLowerCase() !== part.sha256.toLowerCase()) {
          throw new Error('PART_HASH_MISMATCH');
        }
        return result.data;
      } catch (error) {
        lastError = error;
        const messageText = error instanceof Error ? error.message : String(error);
        if (messageText === 'PART_SIZE_MISMATCH' || messageText === 'PART_HASH_MISMATCH') break;
        if (attempt === MAX_RETRIES) break;
        const flood = floodWaitSeconds(error);
        await sleep(flood === undefined ? RETRY_BASE_DELAY_MS * 2 ** (attempt - 1) : flood * 1000);
      }
    }
    throw lastError instanceof Error ? lastError : new Error('PART_DOWNLOAD_FAILED');
  })().finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

/** Test-only: isi cache manifest tanpa melewati Service Worker. */
export function primeManifestCache(manifest: MediaManifest): void {
  manifestCache.set(manifest.objectId, manifest);
}

export async function handlePartRequest(port: PortLike, objectId: string, partNo: number): Promise<void> {
  const manifest = manifestCache.get(objectId);
  const part = manifest?.parts.find((candidate) => candidate.partNo === partNo);
  if (!manifest || !part) {
    port.postMessage({ ok: false, code: 'MANIFEST_MISSING' });
    return;
  }
  const preloadKey = `${objectId}:${partNo}`;
  const ready = preloaded.get(preloadKey);
  if (ready) {
    preloaded.delete(preloadKey);
    const buffer = toArrayBuffer(ready);
    port.postMessage({ ok: true, bytes: buffer }, [buffer]);
    return;
  }
  await acquireSlot();
  try {
    const bytes = await fetchPartBytes(manifest, part);
    const buffer = toArrayBuffer(bytes);
    port.postMessage({ ok: true, bytes: buffer }, [buffer]);
    void prefetchNext(manifest, part.partNo + 1);
  } catch (error) {
    const code = error instanceof Error ? error.message : 'PART_DOWNLOAD_FAILED';
    port.postMessage({ ok: false, code });
  } finally {
    releaseSlot();
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes.buffer as ArrayBuffer;
  }
  return bytes.slice().buffer as ArrayBuffer;
}

function prefetchNext(manifest: MediaManifest, partNo: number): void {
  const part = manifest.parts.find((candidate) => candidate.partNo === partNo);
  if (!part) return;
  const key = `${manifest.objectId}:${partNo}`;
  if (preloaded.has(key) || inflight.has(key)) return;
  void fetchPartBytes(manifest, part)
    .then((bytes) => {
      while (preloaded.size >= 2) {
        const oldest = preloaded.keys().next().value;
        if (oldest === undefined) break;
        preloaded.delete(oldest);
      }
      preloaded.set(key, bytes);
    })
    .catch(() => undefined);
}
