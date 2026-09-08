/* Teledrive media stream proxy — scope: /media/
 * Melayani 206 Partial Content untuk /media/stream/:objectId.
 * Byte TIDAK diambil di sini: SW meminta part ke halaman via MessageChannel,
 * halaman menariknya lewat mtcute (telegram.worker) dan memverifikasi SHA-256. */

const sessions = new Map(); // objectId -> manifest { objectId, mime, size, parts: [{ partNo, messageId, sha256, size }] }
const partCache = new Map(); // "objectId:partNo" -> Uint8Array (urutan Map = urutan masuk, untuk evict LRU)
const CACHE_BUDGET_BYTES = 64 * 1024 * 1024;
const DEFAULT_FIRST_RESPONSE_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MANIFEST_REQUEST_TIMEOUT_MS = 5000;
const PART_REQUEST_TIMEOUT_MS = 30000;

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'td-media-manifest' && data.manifest && data.manifest.objectId) {
    sessions.set(data.manifest.objectId, data.manifest);
    return;
  }
  if (data.type === 'td-media-close' && data.objectId) {
    sessions.delete(data.objectId);
    const prefix = `${data.objectId}:`;
    for (const key of [...partCache.keys()]) {
      if (key.startsWith(prefix)) partCache.delete(key);
    }
  }
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || !url.pathname.startsWith('/media/stream/')) return;
  event.respondWith(handleStream(event.request));
});

function parseRangeHeader(header, size) {
  // Mengikuti semantik lib/media-range.ts: {start,end inklusif} | 'invalid' | 'unsatisfiable'.
  if (!header) return 'invalid';
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return 'invalid';
  const [, rawStart, rawEnd] = match;
  if (size <= 0) return 'unsatisfiable';
  if (rawStart === '' && rawEnd === '') return 'invalid';

  if (rawStart === '') {
    const suffix = Number(rawEnd);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return 'invalid';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }

  const start = Number(rawStart);
  if (!Number.isSafeInteger(start) || start >= size) return start >= size ? 'unsatisfiable' : 'invalid';
  const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (!Number.isSafeInteger(end) || end < start) return 'invalid';
  return { start, end };
}

function cachePut(key, bytes) {
  partCache.delete(key);
  partCache.set(key, bytes);
  let total = 0;
  for (const value of partCache.values()) total += value.byteLength;
  while (total > CACHE_BUDGET_BYTES && partCache.size > 1) {
    const oldestKey = partCache.keys().next().value;
    const oldest = partCache.get(oldestKey);
    total -= oldest.byteLength;
    partCache.delete(oldestKey);
  }
}

function pickClient() {
  return self.clients
    .matchAll({ type: 'window', includeUncontrolled: true })
    .then((clients) => clients[0] || null);
}

function requestManifestFromClients(objectId) {
  return self.clients
    .matchAll({ type: 'window', includeUncontrolled: true })
    .then(async (clients) => {
      for (const client of clients) {
        const reply = await new Promise((resolve) => {
          const channel = new MessageChannel();
          const timer = setTimeout(() => {
            channel.port1.onmessage = null;
            resolve(null);
          }, MANIFEST_REQUEST_TIMEOUT_MS);
          channel.port1.onmessage = (event) => {
            clearTimeout(timer);
            channel.port1.onmessage = null;
            resolve(event.data);
          };
          client.postMessage({ type: 'td-media-manifest-request', objectId }, [channel.port2]);
        });
        if (reply && reply.ok && reply.manifest && reply.manifest.objectId === objectId) return reply.manifest;
      }
      return null;
    });
}

function requestPartFromClient(client, objectId, partNo) {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => {
      channel.port1.onmessage = null;
      resolve(null);
    }, PART_REQUEST_TIMEOUT_MS);
    channel.port1.onmessage = (event) => {
      clearTimeout(timer);
      channel.port1.onmessage = null;
      resolve(event.data);
    };
    client.postMessage({ type: 'td-media-part', objectId, partNo }, [channel.port2]);
  });
}

async function handleStream(request) {
  try {
    const url = new URL(request.url);
    const objectId = decodeURIComponent(url.pathname.slice('/media/stream/'.length));
    if (!objectId) return new Response('missing object id', { status: 404 });

    let manifest = sessions.get(objectId);
    if (!manifest) {
      manifest = await requestManifestFromClients(objectId);
      if (manifest) sessions.set(manifest.objectId, manifest);
    }
    if (!manifest || !Array.isArray(manifest.parts) || manifest.parts.length === 0) {
      return new Response('media session unavailable', { status: 404 });
    }

    const rangeHeader = request.headers.get('range');
    let range;
    if (rangeHeader) {
      const parsed = parseRangeHeader(rangeHeader, manifest.size);
      if (parsed === 'invalid' || parsed === 'unsatisfiable') {
        return new Response('range not satisfiable', {
          status: 416,
          headers: { 'Content-Range': `bytes */${manifest.size}` },
        });
      }
      range = parsed;
    } else {
      range = { start: 0, end: Math.min(DEFAULT_FIRST_RESPONSE_BYTES, manifest.size) - 1 };
    }
    // Batasi ukuran respons per request supaya browser meminta kelanjutan dengan range terbatas.
    range.end = Math.min(range.end, range.start + MAX_RESPONSE_BYTES - 1);

    const client = await pickClient();
    if (!client) return new Response('no active page client', { status: 502 });

    const slices = [];
    let offset = 0;
    let written = 0;
    for (const part of manifest.parts) {
      const partStart = offset;
      const partEnd = offset + part.size - 1;
      offset += part.size;
      if (partEnd < range.start) continue;
      if (partStart > range.end) break;

      const cacheKey = `${objectId}:${part.partNo}`;
      let bytes = partCache.get(cacheKey) || null;
      if (!bytes || bytes.byteLength !== part.size) {
        const reply = await requestPartFromClient(client, objectId, part.partNo);
        if (!reply || !reply.ok || !(reply.bytes instanceof ArrayBuffer) || reply.bytes.byteLength !== part.size) {
          return new Response(`part ${part.partNo} unavailable`, { status: 502 });
        }
        bytes = new Uint8Array(reply.bytes);
        cachePut(cacheKey, bytes);
      }
      const sliceStart = Math.max(partStart, range.start) - partStart;
      const sliceEnd = Math.min(partEnd, range.end) - partStart;
      const slice = bytes.subarray(sliceStart, sliceEnd + 1);
      slices.push(slice);
      written += slice.byteLength;
    }

    const body = new Uint8Array(written);
    let position = 0;
    for (const slice of slices) {
      body.set(slice, position);
      position += slice.byteLength;
    }
    return new Response(body, {
      status: 206,
      headers: {
        'Content-Type': manifest.mime || 'application/octet-stream',
        'Content-Length': String(body.byteLength),
        'Content-Range': `bytes ${range.start}-${range.start + body.byteLength - 1}/${manifest.size}`,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
      },
    });
  } catch {
    return new Response('media proxy error', { status: 502 });
  }
}
