import { bytesToHex } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { describe, expect, it } from 'vitest';
import type { ApiClient, UploadPart, UploadResponse, UploadSession } from './api';
import { UploadController } from './upload-controller';

const chunkSize = 8 * 1024 * 1024;

function fakeApi(events: string[], parts: UploadPart[] = []): ApiClient {
  const session: UploadSession = {
    id: 'upload-1',
    objectId: 'object-1',
    status: 'created',
    chunkSize,
    expectedPartCount: 2,
    expiresAt: '2099-01-01T00:00:00.000Z',
  };
  const detail: UploadResponse = {
    ...session,
    object: {
      id: 'object-1',
      name: 'file.bin',
      mime: 'application/octet-stream',
      size: chunkSize + 1,
      sha256: null,
      status: 'uploading',
    },
    parts,
  };
  return {
    getCsrf: async () => 'csrf',
    registerPasskeyOptions: async () => {
      throw new Error('unused');
    },
    registerPasskeyVerify: async () => {
      throw new Error('unused');
    },
    authenticatePasskeyOptions: async () => {
      throw new Error('unused');
    },
    authenticatePasskeyVerify: async () => {
      throw new Error('unused');
    },
    getCurrentSession: async () => null,
    logout: async () => ({ ok: true }),
    getWorkspace: async () => {
      events.push('workspace');
      return { workspace: { id: 'workspace-1', name: 'My Drive' }, rootFolder: { id: 'root-1', name: 'My Drive' } };
    },
    listFolderChildren: async () => {
      throw new Error('unused');
    },
    listRecent: async () => {
      throw new Error('unused');
    },
    listTrash: async () => {
      throw new Error('unused');
    },
    createFolder: async () => {
      throw new Error('unused');
    },
    updateFolder: async () => {
      throw new Error('unused');
    },
    updateObject: async () => {
      throw new Error('unused');
    },
    softDeleteObject: async () => {
      throw new Error('unused');
    },
    restoreObject: async () => {
      throw new Error('unused');
    },
    permanentDeleteObject: async () => {
      throw new Error('unused');
    },
    softDeleteFolder: async () => {
      throw new Error('unused');
    },
    restoreFolder: async () => {
      throw new Error('unused');
    },
    permanentDeleteFolder: async () => {
      throw new Error('unused');
    },
    startUpload: async () => {
      events.push('start');
      return session;
    },
    getUpload: async () => {
      events.push('get');
      return detail;
    },
    commitPart: async (_uploadId, part) => {
      if (!('idempotencyKey' in part)) throw new Error('idempotency key missing');
      events.push(`commit:${part.partNo}`);
      const committed: UploadPart = {
        id: `part-${part.partNo}`,
        objectId: 'object-1',
        botFileId: null,
        createdAt: '2099-01-01T00:00:00.000Z',
        ...part,
      };
      detail.parts.push(committed);
      return committed;
    },
    completeUpload: async () => {
      events.push('complete');
      return { objectId: 'object-1', status: 'completed', idempotent: false };
    },
    abortUpload: async () => ({ ok: true, status: 'aborted' }),
    getManifest: async () => {
      throw new Error('unused');
    },
    exportWorkspace: async () => {
      throw new Error('unused');
    },
  };
}

describe('UploadController', () => {
  it('hashes sliced chunks without reading the full File and completes after every commit', async () => {
    const bytes = new Uint8Array(chunkSize + 1);
    bytes.forEach((_, index) => {
      bytes[index] = index % 251;
    });
    const file = new Blob([bytes], { type: 'application/octet-stream' }) as Blob & { name: string };
    Object.defineProperty(file, 'name', { value: 'file.bin' });
    Object.defineProperty(file, 'arrayBuffer', {
      value: () => {
        throw new Error('full File.arrayBuffer() must not be called');
      },
    });

    const events: string[] = [];
    const commits: Array<{ partNo: number; size: number; sha256: string; messageId: string; idempotencyKey: string }> =
      [];
    let keyNumber = 0;
    const controller = new UploadController({
      file,
      chunkSize,
      concurrency: 1,
      api: fakeApi(events) as ApiClient,
      idempotencyKey: () => `opaque-${++keyNumber}`,
      gateway: {
        async checkSession() {
          events.push('checkSession');
          return { connected: true, authorized: true };
        },
        async uploadPart(chunk, partNo, onProgress) {
          events.push(`telegram:${partNo}`);
          onProgress?.(chunk.size);
          return {
            messageId: `message-${partNo}`,
            partNo,
            sha256: '',
            size: chunk.size,
            fileName: 'file.bin',
            mime: chunk.type,
          };
        },
      },
    });

    const result = await controller.start();
    expect(events).toEqual([
      'checkSession',
      'workspace',
      'start',
      'get',
      'telegram:0',
      'commit:0',
      'telegram:1',
      'commit:1',
      'complete',
    ]);
    expect(result.partCount).toBe(2);
    expect(result.sha256).toBe(bytesToHex(sha256(bytes)));
    expect(result.parts.map((part) => part.sha256)).toEqual([
      bytesToHex(sha256(bytes.slice(0, chunkSize))),
      bytesToHex(sha256(bytes.slice(chunkSize))),
    ]);
    expect(result.parts.every((part) => part.idempotencyKey.startsWith('opaque-'))).toBe(true);
  });

  it('requires authorized Telegram session before reading, hashing, or starting upload', async () => {
    const file = new Blob(['not-read'], { type: 'application/octet-stream' }) as Blob & { name: string };
    Object.defineProperty(file, 'name', { value: 'blocked.bin' });
    Object.defineProperty(file, 'arrayBuffer', {
      value: () => {
        throw new Error('hashing must not start');
      },
    });
    const events: string[] = [];
    const controller = new UploadController({
      file,
      api: fakeApi(events),
      gateway: {
        checkSession: async () => {
          events.push('checkSession');
          return { connected: true, authorized: false };
        },
        uploadPart: async () => {
          events.push('telegram');
          throw new Error('Telegram upload must not start');
        },
      },
    });

    await expect(controller.start()).rejects.toMatchObject({ code: 'TG_AUTH_REQUIRED' });
    expect(events).toEqual(['checkSession']);
  });
});
