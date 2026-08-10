import { bytesToHex } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient, BotManifestResponse } from './api';
import { DownloadController, MAX_PART_BYTES } from './download-controller';

const streamSaverMock = vi.hoisted(() => ({
  supported: true,
  mitm: 'vendor-default',
  createWriteStream: vi.fn(),
}));
vi.mock('streamsaver', () => ({ default: streamSaverMock }));

const objectId = 'object-1';

function concat(parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function makeManifest(data: Uint8Array[]): BotManifestResponse {
  const allBytes = concat(data);
  return {
    object: {
      id: objectId,
      folderId: 'folder-1',
      name: 'report.pdf',
      mime: 'application/pdf',
      size: allBytes.byteLength,
      sha256: bytesToHex(sha256(allBytes)),
      partCount: data.length,
      status: 'completed',
      createdAt: '2099-01-01T00:00:00.000Z',
      updatedAt: '2099-01-01T00:00:00.000Z',
    },
    parts: data.map((bytes, partNo) => ({ partNo, size: bytes.byteLength, sha256: bytesToHex(sha256(bytes)) })),
  };
}

function fakeApi(manifest: BotManifestResponse, events: string[]) {
  return {
    getBotManifest: vi.fn(async (requestedObjectId) => {
      events.push(`manifest:${requestedObjectId}`);
      return manifest;
    }),
    getBotPartContent: vi.fn(async (_requestedObjectId, partNo) => {
      events.push(`part:${partNo}`);
      const part = manifest.parts.find((candidate) => candidate.partNo === partNo);
      if (!part) throw new Error('unknown test part');
      const data = Uint8Array.from({ length: part.size }, (_, index) => (partNo * 2 + index + 1) % 251);
      return new Response(data);
    }),
  };
}

function dataManifest(): BotManifestResponse {
  return makeManifest([new Uint8Array([1, 2]), new Uint8Array([3, 4])]);
}

afterEach(() => {
  vi.unstubAllGlobals();
  streamSaverMock.createWriteStream.mockReset();
  streamSaverMock.mitm = 'vendor-default';
  streamSaverMock.supported = true;
});

describe('DownloadController', () => {
  it('downloads Bot objects with binary content and hashes', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:preview'), revokeObjectURL: vi.fn() });
    const manifest = makeManifest([new Uint8Array([1, 2]), new Uint8Array([3, 4])]);
    const events: string[] = [];
    const api = fakeApi(manifest, events);
    const controller = new DownloadController({ api });

    const preview = await controller.loadPreview(objectId);
    expect(events).toEqual(['manifest:object-1', 'part:0', 'part:1']);
    expect(preview).toMatchObject({ mime: 'application/pdf', size: 4 });
  });

  it('stops on part integrity failure before downloading later parts', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('URL', { createObjectURL: vi.fn(), revokeObjectURL: vi.fn() });
    const manifest = dataManifest();
    const api = fakeApi(manifest, []);
    api.getBotPartContent = vi.fn(async () => new Response(Uint8Array.from([255, 255])));
    const controller = new DownloadController({ api });

    await expect(controller.loadPreview(objectId)).rejects.toMatchObject({ code: 'PART_HASH_MISMATCH' });
    expect(api.getBotPartContent).toHaveBeenCalledTimes(1);
  });

  it('retries transient binary content failures', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('URL', { createObjectURL: vi.fn(), revokeObjectURL: vi.fn() });
    const manifest = dataManifest();
    const events: string[] = [];
    const api = fakeApi(manifest, events);
    api.getBotPartContent.mockImplementationOnce(async () => {
      throw new Error('network connection reset');
    });
    const controller = new DownloadController({ api });

    await expect(controller.loadPreview(objectId)).resolves.toMatchObject({ size: 4 });
    expect(api.getBotPartContent).toHaveBeenCalledTimes(3);
    expect(events).toEqual(['manifest:object-1', 'part:0', 'part:1']);
  });

  it('uses StreamSaver for verified large-path saves without Telegram inputs', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('navigator', { serviceWorker: {} });
    const writes: number[][] = [];
    const writer = {
      write: vi.fn(async (bytes: Uint8Array) => writes.push([...bytes])),
      close: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
    };
    streamSaverMock.createWriteStream.mockReturnValue({ getWriter: () => writer });
    const manifest = dataManifest();
    const controller = new DownloadController({ api: fakeApi(manifest, []) });

    await expect(controller.save(objectId)).resolves.toMatchObject({ method: 'streamsaver', size: 4 });
    expect(streamSaverMock.mitm).toBe('/streamsaver/mitm.html');
    expect(writes).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it('stops without network or fallback when known-file picker is cancelled', async () => {
    const events: string[] = [];
    vi.stubGlobal('window', {
      showSaveFilePicker: vi.fn(() => {
        events.push('picker');
        return Promise.reject(new DOMException('cancelled', 'AbortError'));
      }),
    });
    const manifest = dataManifest();
    const api = fakeApi(manifest, events);
    const controller = new DownloadController({ api });

    await expect(controller.save(objectId, { name: 'report.pdf', size: 4 })).resolves.toMatchObject({
      method: 'cancelled',
    });
    expect(events[0]).toBe('picker');
    expect(api.getBotManifest).not.toHaveBeenCalled();
    expect(streamSaverMock.createWriteStream).not.toHaveBeenCalled();
  });

  it('falls back after non-cancel picker failure', async () => {
    vi.stubGlobal('window', {
      showSaveFilePicker: vi.fn(async () => {
        throw new Error('permission denied');
      }),
    });
    vi.stubGlobal('navigator', { serviceWorker: {} });
    const writer = {
      write: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
    };
    streamSaverMock.createWriteStream.mockReturnValue({ getWriter: () => writer });
    const manifest = dataManifest();
    const api = fakeApi(manifest, []);

    await expect(
      new DownloadController({ api }).save(objectId, { name: 'report.pdf', size: 4 }),
    ).resolves.toMatchObject({
      method: 'streamsaver',
    });
    expect(api.getBotManifest).toHaveBeenCalledOnce();
  });

  it('rejects manifest parts above the Bot API content ceiling', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('URL', { createObjectURL: vi.fn(), revokeObjectURL: vi.fn() });
    const manifest = makeManifest([new Uint8Array([1])]);
    manifest.object.size = MAX_PART_BYTES + 1;
    manifest.parts[0].size = MAX_PART_BYTES + 1;
    manifest.parts[0].sha256 = 'a'.repeat(64);
    const controller = new DownloadController({ api: fakeApi(manifest, []) });

    await expect(controller.loadPreview(objectId)).rejects.toMatchObject({ code: 'INVALID_MANIFEST' });
  });
});
