import { bytesToHex } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient, ManifestResponse } from './api';
import { DownloadController, MAX_BLOB_FALLBACK_BYTES, MAX_PREVIEW_BYTES } from './download-controller';
import type { TelegramDownloadResult } from './telegram-gateway';

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

function makeManifest(data: Uint8Array[], mime = 'application/pdf'): ManifestResponse {
  const allBytes = concat(data);
  return {
    object: {
      id: objectId,
      folderId: 'folder-1',
      name: 'report.pdf',
      mime,
      size: allBytes.byteLength,
      sha256: bytesToHex(sha256(allBytes)),
      partCount: data.length,
      status: 'available',
      deletedAt: null,
      createdAt: '2099-01-01T00:00:00.000Z',
      updatedAt: '2099-01-01T00:00:00.000Z',
    },
    parts: data.map((bytes, partNo) => ({
      id: `part-${partNo}`,
      objectId,
      partNo,
      size: bytes.byteLength,
      sha256: bytesToHex(sha256(bytes)),
      messageId: String(partNo + 1),
      botFileId: null,
      idempotencyKey: `key-${partNo}`,
      createdAt: '2099-01-01T00:00:00.000Z',
    })),
  };
}

function fakeApi(manifest: ManifestResponse, events: string[]): Pick<ApiClient, 'getManifest'> {
  return {
    getManifest: vi.fn(async (requestedObjectId) => {
      events.push(`manifest:${requestedObjectId}`);
      return manifest;
    }),
  };
}

function fakeGateway(manifest: ManifestResponse, events: string[], badPartNo?: number) {
  return {
    checkSession: vi.fn(async () => {
      events.push('session');
      return { connected: true, authorized: true };
    }),
    downloadPart: vi.fn(
      async (
        _channel: string,
        requestedMessageId: number,
        onProgress?: (bytes: number, total: number) => void,
      ): Promise<TelegramDownloadResult> => {
        const part = manifest.parts.find((candidate) => Number(candidate.messageId) === requestedMessageId);
        if (!part) throw new Error('unknown test message');
        events.push(`part:${part.partNo}`);
        const source = dataForPart(manifest, part.partNo);
        const data = part.partNo === badPartNo ? Uint8Array.from(source, () => 255) : source;
        onProgress?.(data.byteLength, data.byteLength);
        return {
          messageId: requestedMessageId,
          data,
          fileName: manifest.object.name,
          mime: manifest.object.mime,
          size: data.byteLength,
        };
      },
    ),
  };
}

function dataForPart(manifest: ManifestResponse, partNo: number): Uint8Array {
  const part = manifest.parts.find((candidate) => candidate.partNo === partNo);
  if (!part) throw new Error('unknown test part');
  return Uint8Array.from({ length: part.size }, (_, index) => (partNo * 2 + index + 1) % 251);
}

function dataManifest(): ManifestResponse {
  const manifest = makeManifest([new Uint8Array([1, 2]), new Uint8Array([3, 4])]);
  manifest.parts[0].sha256 = bytesToHex(sha256(new Uint8Array([1, 2])));
  manifest.parts[1].sha256 = bytesToHex(sha256(new Uint8Array([3, 4])));
  manifest.object.sha256 = bytesToHex(sha256(new Uint8Array([1, 2, 3, 4])));
  return manifest;
}

afterEach(() => {
  vi.unstubAllGlobals();
  streamSaverMock.createWriteStream.mockReset();
  streamSaverMock.mitm = 'vendor-default';
  streamSaverMock.supported = true;
});

describe('DownloadController', () => {
  it('downloads ordered parts, verifies hashes, and reports completion', async () => {
    vi.stubGlobal('window', {});
    const createObjectURL = vi.fn(() => 'blob:preview');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });

    const manifest = dataManifest();
    manifest.parts.reverse();
    const events: string[] = [];
    const progress: Array<{ phase: string; bytesDownloaded: number; completedParts: number }> = [];
    const gateway = fakeGateway(manifest, events);
    const controller = new DownloadController({
      channel: 'configured-channel',
      api: fakeApi(manifest, events),
      gateway,
      onProgress: ({ phase, bytesDownloaded, completedParts }) =>
        progress.push({ phase, bytesDownloaded, completedParts }),
    });

    const preview = await controller.loadPreview(objectId);

    expect(events).toEqual(['session', 'manifest:object-1', 'part:0', 'part:1']);
    expect(gateway.downloadPart.mock.calls.map((call) => call[0])).toEqual([
      'configured-channel',
      'configured-channel',
    ]);
    expect(preview).toMatchObject({ url: 'blob:preview', mime: 'application/pdf', size: 4 });
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(progress.at(-1)).toEqual({ phase: 'completed', bytesDownloaded: 4, completedParts: 2 });
    preview.revoke();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:preview');
  });

  it('stops on part integrity failure before downloading later parts', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('URL', { createObjectURL: vi.fn(), revokeObjectURL: vi.fn() });
    const manifest = dataManifest();
    const events: string[] = [];
    const gateway = fakeGateway(manifest, events, 0);
    const controller = new DownloadController({
      channel: 'configured-channel',
      api: fakeApi(manifest, events),
      gateway,
    });

    await expect(controller.loadPreview(objectId)).rejects.toMatchObject({ code: 'PART_HASH_MISMATCH' });
    expect(events).toEqual(['session', 'manifest:object-1', 'part:0']);
  });

  it('retries a transient Telegram part failure before completing', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('URL', { createObjectURL: vi.fn(), revokeObjectURL: vi.fn() });
    const manifest = dataManifest();
    const events: string[] = [];
    const gateway = fakeGateway(manifest, events);
    gateway.downloadPart.mockImplementationOnce(async () => {
      throw new Error('network connection reset');
    });
    const controller = new DownloadController({
      channel: 'configured-channel',
      api: fakeApi(manifest, events),
      gateway,
    });

    await expect(controller.loadPreview(objectId)).resolves.toMatchObject({ size: 4 });
    expect(gateway.downloadPart).toHaveBeenCalledTimes(3);
    expect(gateway.downloadPart.mock.calls.map((call) => call[1])).toEqual([1, 1, 2]);
  });

  it('requires Telegram authorization and honors pre-aborted signals before metadata access', async () => {
    vi.stubGlobal('window', {});
    const manifest = dataManifest();
    const events: string[] = [];
    const api = fakeApi(manifest, events);
    const unauthorizedGateway = {
      checkSession: vi.fn(async () => ({ connected: true, authorized: false })),
      downloadPart: vi.fn(),
    };
    await expect(
      new DownloadController({ api, gateway: unauthorizedGateway }).loadPreview(objectId),
    ).rejects.toMatchObject({ code: 'TG_AUTH_REQUIRED' });
    expect(api.getManifest).not.toHaveBeenCalled();

    const abortController = new AbortController();
    abortController.abort();
    const gateway = fakeGateway(manifest, events);
    await expect(
      new DownloadController({ api, gateway, signal: abortController.signal }).loadPreview(objectId),
    ).rejects.toMatchObject({ code: 'DOWNLOAD_ABORTED' });
    expect(gateway.checkSession).not.toHaveBeenCalled();
  });

  it('rejects unsupported and oversized previews before Telegram part download', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('URL', { createObjectURL: vi.fn(), revokeObjectURL: vi.fn() });
    const unsupported = makeManifest([new Uint8Array([1])], 'application/octet-stream');
    const unsupportedEvents: string[] = [];
    const unsupportedGateway = fakeGateway(unsupported, unsupportedEvents);
    await expect(
      new DownloadController({
        channel: 'configured-channel',
        api: fakeApi(unsupported, unsupportedEvents),
        gateway: unsupportedGateway,
      }).loadPreview(objectId),
    ).rejects.toMatchObject({ code: 'PREVIEW_UNSUPPORTED_MIME' });
    expect(unsupportedEvents).toEqual(['session', 'manifest:object-1']);

    const oversized = makeManifest([new Uint8Array([1])]);
    oversized.object.size = MAX_PREVIEW_BYTES + 1;
    oversized.object.partCount = 1;
    oversized.object.sha256 = 'a'.repeat(64);
    oversized.parts[0].size = MAX_PREVIEW_BYTES + 1;
    oversized.parts[0].sha256 = 'b'.repeat(64);
    const oversizedEvents: string[] = [];
    const oversizedGateway = fakeGateway(oversized, oversizedEvents);
    await expect(
      new DownloadController({
        channel: 'configured-channel',
        api: fakeApi(oversized, oversizedEvents),
        gateway: oversizedGateway,
      }).loadPreview(objectId),
    ).rejects.toMatchObject({ code: 'PREVIEW_TOO_LARGE' });
    expect(oversizedEvents).toEqual(['session', 'manifest:object-1']);
  });

  it('streams verified ordered parts when File System Access is absent', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('navigator', { serviceWorker: {} });
    const writes: number[][] = [];
    const writer = {
      write: vi.fn(async (bytes: Uint8Array) => {
        writes.push([...bytes]);
      }),
      close: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
    };
    streamSaverMock.createWriteStream.mockImplementation((name: string, options: { size: number }) => {
      expect(name).toBe('report.pdf');
      expect(options).toEqual({ size: 4 });
      return { getWriter: () => writer };
    });
    const manifest = dataManifest();
    const events: string[] = [];
    const controller = new DownloadController({
      channel: 'configured-channel',
      api: fakeApi(manifest, events),
      gateway: fakeGateway(manifest, events),
    });

    await expect(controller.save(objectId)).resolves.toMatchObject({ method: 'streamsaver', size: 4 });
    expect(streamSaverMock.mitm).toBe('/streamsaver/mitm.html');
    expect(writes).toEqual([
      [1, 2],
      [3, 4],
    ]);
    expect(writer.close).toHaveBeenCalledOnce();
    expect(writer.abort).not.toHaveBeenCalled();
  });

  it('uses StreamSaver above Blob fallback ceiling without creating a Blob', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('navigator', { serviceWorker: {} });
    const blob = vi.fn();
    vi.stubGlobal('Blob', blob);
    const bytes = new Uint8Array([1, 2]);
    Object.defineProperty(bytes, 'byteLength', { value: MAX_BLOB_FALLBACK_BYTES + 1 });
    const manifest = makeManifest([new Uint8Array([1, 2])]);
    manifest.object.size = MAX_BLOB_FALLBACK_BYTES + 1;
    manifest.object.partCount = 1;
    manifest.object.sha256 = bytesToHex(sha256(bytes));
    manifest.parts[0].size = MAX_BLOB_FALLBACK_BYTES + 1;
    manifest.parts[0].sha256 = bytesToHex(sha256(bytes));
    const writer = {
      write: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
    };
    streamSaverMock.createWriteStream.mockReturnValue({ getWriter: () => writer });
    const controller = new DownloadController({
      channel: 'configured-channel',
      api: fakeApi(manifest, []),
      gateway: {
        checkSession: vi.fn(async () => ({ connected: true, authorized: true })),
        downloadPart: vi.fn(async () => ({
          messageId: 1,
          data: bytes,
          fileName: manifest.object.name,
          mime: manifest.object.mime,
          size: bytes.byteLength,
        })),
      },
    });

    await expect(controller.save(objectId)).resolves.toMatchObject({
      method: 'streamsaver',
      size: MAX_BLOB_FALLBACK_BYTES + 1,
    });
    expect(writer.close).toHaveBeenCalledOnce();
    expect(blob).not.toHaveBeenCalled();
  });
});
