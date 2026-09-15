import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { telegramGateway } from './telegram-gateway';
import {
  handlePartRequest,
  handleRangeRequest,
  primeManifestCache,
  rangeChunksForPart,
  setSleepFunction,
  buildMediaManifest,
} from './media-bridge';
import type { MediaManifest } from './media-range';

vi.mock('./telegram-gateway', () => ({ telegramGateway: { downloadPart: vi.fn() } }));

const mockedDownload = vi.mocked(telegramGateway.downloadPart);

function makePart(partNo: number, bytes: Uint8Array, messageId = String(partNo + 1)) {
  return { partNo, messageId, sha256: bytesToHex(sha256(bytes)), size: bytes.byteLength };
}

function makeManifest(parts: MediaManifest['parts']): MediaManifest {
  return {
    objectId: 'object-1',
    mime: 'video/mp4',
    size: parts.reduce((total, part) => total + part.size, 0),
    chunkSize: parts[0]?.size ?? 0,
    parts,
  };
}

function fakePort() {
  const replies: Array<{ message: unknown; transfer: Transferable[] }> = [];
  return {
    replies,
    postMessage: vi.fn((message: unknown, transfer?: Transferable[]) => {
      replies.push({ message, transfer: transfer ?? [] });
    }),
  };
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_TELEGRAM_CHANNEL = 'test-channel';
  mockedDownload.mockReset();
  setSleepFunction(() => Promise.resolve());
});

describe('handlePartRequest', () => {
  it('downloads, verifies, and transfers the part buffer', async () => {
    const bytes = Uint8Array.from([1, 2, 3, 4]);
    primeManifestCache(makeManifest([makePart(0, bytes)]));
    mockedDownload.mockResolvedValue({
      messageId: 1,
      data: bytes,
      fileName: 'video.mp4',
      mime: 'video/mp4',
      size: bytes.byteLength,
    });
    const port = fakePort();

    await handlePartRequest(port, 'object-1', 0);

    expect(mockedDownload).toHaveBeenCalledWith(expect.any(String), 1, undefined, undefined);
    const reply = port.replies[0].message as { ok: boolean; bytes: ArrayBuffer };
    expect(reply.ok).toBe(true);
    expect(new Uint8Array(reply.bytes)).toEqual(bytes);
    expect(port.replies[0].transfer).toContain(reply.bytes);
  });

  it('replies with ok:false on hash mismatch after exhausting retries', async () => {
    const bytes = Uint8Array.from([1, 2, 3, 4]);
    primeManifestCache(makeManifest([makePart(0, bytes)]));
    mockedDownload.mockResolvedValue({
      messageId: 1,
      data: Uint8Array.from([9, 9, 9, 9]),
      fileName: 'video.mp4',
      mime: 'video/mp4',
      size: 4,
    });
    const port = fakePort();

    await handlePartRequest(port, 'object-1', 0);

    expect(mockedDownload).toHaveBeenCalledTimes(4);
    expect(port.replies[0].message).toMatchObject({ ok: false, code: 'PART_HASH_MISMATCH' });
  });

  it('replies with ok:false when part size does not match the manifest', async () => {
    const bytes = Uint8Array.from([1, 2, 3, 4]);
    primeManifestCache(makeManifest([makePart(0, bytes)]));
    mockedDownload.mockResolvedValue({
      messageId: 1,
      data: Uint8Array.from([1, 2]),
      fileName: 'video.mp4',
      mime: 'video/mp4',
      size: 2,
    });
    const port = fakePort();

    await handlePartRequest(port, 'object-1', 0);

    expect(mockedDownload).toHaveBeenCalledTimes(1);
    expect(port.replies[0].message).toMatchObject({ ok: false, code: 'PART_SIZE_MISMATCH' });
  });

  it('retries transient failures and honors FLOOD_WAIT seconds', async () => {
    const bytes = Uint8Array.from([5, 6]);
    primeManifestCache(makeManifest([makePart(0, bytes)]));
    mockedDownload.mockRejectedValueOnce(new Error('FLOOD_WAIT_2 (wait 2 seconds)')).mockResolvedValueOnce({
      messageId: 1,
      data: bytes,
      fileName: 'video.mp4',
      mime: 'video/mp4',
      size: bytes.byteLength,
    });
    const sleeps: number[] = [];
    setSleepFunction((ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    });
    const port = fakePort();

    await handlePartRequest(port, 'object-1', 0);

    expect(sleeps).toEqual([2000]);
    expect(mockedDownload).toHaveBeenCalledTimes(2);
    expect(port.replies[0].message).toMatchObject({ ok: true });
  });

  it('limits part downloads to four concurrent requests', async () => {
    const partData = [0, 1, 2, 3, 4].map((partNo) => Uint8Array.from([partNo, 1, 2, 3]));
    const parts = partData.map((data, partNo) => makePart(partNo, data));
    primeManifestCache(makeManifest(parts));
    const gates = partData.map(() => deferred());
    mockedDownload.mockImplementation(async (_channel: string, messageId: number) => {
      const gate = gates[mockedDownload.mock.calls.length - 1] ?? gates[gates.length - 1];
      await gate.promise;
      const data = partData[messageId - 1];
      return { messageId, data, fileName: 'video.mp4', mime: 'video/mp4', size: data.byteLength };
    });
    const ports = partData.map(() => fakePort());

    const runs = ports.map((port, index) => handlePartRequest(port, 'object-1', index));
    await Promise.resolve();
    expect(mockedDownload).toHaveBeenCalledTimes(4);

    gates[0].resolve();
    await vi.waitFor(() => expect(mockedDownload).toHaveBeenCalledTimes(5));
    for (const gate of gates) gate.resolve();
    await Promise.all(runs);
    for (const port of ports) expect(port.replies[0].message).toMatchObject({ ok: true });
  });

  it('answers MANIFEST_MISSING for unknown objects', async () => {
    const port = fakePort();
    await handlePartRequest(port, 'unknown', 0);
    expect(mockedDownload).not.toHaveBeenCalled();
    expect(port.replies[0].message).toMatchObject({ ok: false, code: 'MANIFEST_MISSING' });
  });
});

describe('handleRangeRequest', () => {
  const partBytes = Uint8Array.from([10, 20, 30, 40, 50, 60, 70, 80]);

  it('downloads only the requested byte slice', async () => {
    primeManifestCache(makeManifest([makePart(0, partBytes)]));
    mockedDownload.mockImplementation(async (_channel: string, _messageId: number, _onProgress?: unknown, range?: { byteOffset: number; byteLimit: number }) => {
      const slice = partBytes.slice(range?.byteOffset ?? 0, (range?.byteOffset ?? 0) + (range?.byteLimit ?? partBytes.length));
      return { messageId: 1, data: slice, fileName: 'video.mp4', mime: 'video/mp4', size: slice.byteLength };
    });
    const port = fakePort();

    await handleRangeRequest(port, 'object-1', 2, 5);

    expect(mockedDownload).toHaveBeenCalledWith('test-channel', 1, undefined, { byteOffset: 2, byteLimit: 4 });
    const reply = port.replies[0].message as { ok: boolean; bytes: ArrayBuffer };
    expect(reply.ok).toBe(true);
    expect(Array.from(new Uint8Array(reply.bytes))).toEqual([30, 40, 50, 60]);
  });

  it('splits ranges spanning parts into per-part sub-requests', async () => {
    const first = Uint8Array.from([1, 2, 3, 4]);
    const second = Uint8Array.from([5, 6, 7, 8]);
    primeManifestCache(makeManifest([makePart(0, first), makePart(1, second)]));
    mockedDownload.mockImplementation(async (_channel: string, messageId: number, _onProgress?: unknown, range?: { byteOffset: number; byteLimit: number }) => {
      const source = messageId === 1 ? first : second;
      const slice = source.slice(range?.byteOffset ?? 0, (range?.byteOffset ?? 0) + (range?.byteLimit ?? source.length));
      return { messageId, data: slice, fileName: 'video.mp4', mime: 'video/mp4', size: slice.byteLength };
    });
    const port = fakePort();

    await handleRangeRequest(port, 'object-1', 2, 5);

    expect(mockedDownload).toHaveBeenCalledWith('test-channel', 1, undefined, { byteOffset: 2, byteLimit: 2 });
    expect(mockedDownload).toHaveBeenCalledWith('test-channel', 2, undefined, { byteOffset: 0, byteLimit: 2 });
    const reply = port.replies[0].message as { ok: boolean; bytes: ArrayBuffer };
    expect(reply.ok).toBe(true);
    expect(Array.from(new Uint8Array(reply.bytes))).toEqual([3, 4, 5, 6]);
  });

  it('rejects out-of-bounds ranges without downloading', async () => {
    primeManifestCache(makeManifest([makePart(0, partBytes)]));
    const port = fakePort();

    await handleRangeRequest(port, 'object-1', 0, 8);

    expect(mockedDownload).not.toHaveBeenCalled();
    expect(port.replies[0].message).toMatchObject({ ok: false, code: 'RANGE_INVALID' });
  });
});

describe('rangeChunksForPart', () => {
  it('returns a single chunk for small slices', () => {
    expect(rangeChunksForPart(0, 100, 2, 5)).toEqual([{ byteOffset: 2, byteLimit: 4 }]);
  });

  it('clamps to the intersection with the part', () => {
    expect(rangeChunksForPart(10, 10, 0, 100)).toEqual([{ byteOffset: 0, byteLimit: 10 }]);
  });
});

describe('buildMediaManifest', () => {
  it('sorts parts by partNo and derives chunk size from the first part', () => {
    const manifest = buildMediaManifest({
      object: {
        id: 'object-1',
        folderId: 'folder-1',
        name: 'v.mp4',
        mime: 'video/mp4',
        size: 40,
        sha256: null,
        partCount: 3,
        status: 'completed',
        deletedAt: null,
        createdAt: '',
        updatedAt: '',
        thumbnail: null,
      },
      parts: [
        {
          id: 'p2',
          objectId: 'object-1',
          partNo: 2,
          size: 10,
          sha256: 'c'.repeat(64),
          messageId: '13',
          botFileId: null,
          idempotencyKey: 'k2',
          createdAt: '',
        },
        {
          id: 'p0',
          objectId: 'object-1',
          partNo: 0,
          size: 20,
          sha256: 'a'.repeat(64),
          messageId: '11',
          botFileId: null,
          idempotencyKey: 'k0',
          createdAt: '',
        },
        {
          id: 'p1',
          objectId: 'object-1',
          partNo: 1,
          size: 10,
          sha256: 'b'.repeat(64),
          messageId: '12',
          botFileId: null,
          idempotencyKey: 'k1',
          createdAt: '',
        },
      ],
    });
    expect(manifest.parts.map((part) => part.partNo)).toEqual([0, 1, 2]);
    expect(manifest.chunkSize).toBe(20);
    expect(manifest.size).toBe(40);
  });
});
