import { bytesToHex } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, type ApiClient, type BotPart, type BotUploadSession } from './api';
import { MAX_FILE_SIZE, UploadController } from './upload-controller';

const chunkSize = 8 * 1024 * 1024;

function makeApi(
  events: string[],
  onUpload?: (partNo: number) => Promise<void> | void,
): Pick<
  ApiClient,
  | 'startBotUpload'
  | 'getBotPartAttempt'
  | 'uploadBotPart'
  | 'completeBotUpload'
  | 'abortBotUpload'
  | 'abandonBotPartAttempt'
> {
  const committed = new Set<number>();
  const session: BotUploadSession = {
    id: 'upload-1',
    objectId: 'object-1',
    status: 'created',
    chunkSize,
    expectedPartCount: 2,
    expiresAt: '2099-01-01T00:00:00.000Z',
  };
  return {
    startBotUpload: async () => {
      events.push('start');
      return session;
    },
    getBotPartAttempt: async (_uploadId, partNo) => {
      events.push(`status:${partNo}`);
      return { partNo, status: committed.has(partNo) ? 'committed' : 'not_started' };
    },
    uploadBotPart: async (_uploadId, partNo, _body, input) => {
      events.push(`upload:${partNo}`);
      await onUpload?.(partNo);
      const result: BotPart = { partNo, size: input.size, sha256: input.sha256 };
      committed.add(partNo);
      return result;
    },
    completeBotUpload: async () => {
      events.push('complete');
      return { objectId: 'object-1', status: 'completed', idempotent: false };
    },
    abortBotUpload: async () => ({ ok: true, status: 'aborted' }),
    abandonBotPartAttempt: async (_uploadId, partNo) => ({ partNo, status: 'abandoned' as const }),
  };
}

function testFile(): Blob & { name: string } {
  const bytes = new Uint8Array(chunkSize + 1);
  bytes.forEach((_, index) => {
    bytes[index] = index % 251;
  });
  const file = new Blob([bytes], { type: 'application/octet-stream' }) as Blob & { name: string };
  Object.defineProperty(file, 'name', { value: 'file.bin' });
  return file;
}

describe('UploadController', () => {
  it('sends Bot parts and serializes upload', async () => {
    const events: string[] = [];
    const controller = new UploadController({
      file: testFile(),
      chunkSize,
      api: makeApi(events),
      idempotencyKey: (() => {
        let count = 0;
        return () => `key-${++count}`;
      })(),
    });

    const result = await controller.start();
    expect(events).toEqual(['start', 'status:0', 'upload:0', 'status:1', 'upload:1', 'complete']);
    expect(result.partCount).toBe(2);
    expect(result.sha256).toBe(bytesToHex(sha256(new Uint8Array(await await new Blob([testFile()]).arrayBuffer()))));
  });

  it('honors Retry-After before safely retrying a not-started part', async () => {
    const events: string[] = [];
    let failed = true;
    const sleep = vi.fn(async () => undefined);
    const controller = new UploadController({
      file: testFile(),
      chunkSize,
      api: makeApi(events, async (partNo) => {
        if (partNo === 0 && failed) {
          failed = false;
          throw new ApiError('RATE_LIMITED', 'retry', 429, undefined, 2);
        }
      }),
      sleep,
    });

    await expect(controller.start()).resolves.toMatchObject({ partCount: 2 });
    expect(sleep).toHaveBeenCalledWith(2000, expect.any(AbortSignal));
  });

  it('surfaces ambiguous Bot attempts without blind resend', async () => {
    const events: string[] = [];
    let rawCalls = 0;
    const base = makeApi(events, async () => {
      rawCalls += 1;
      throw new ApiError('UPSTREAM_FAILED', 'ambiguous', 502);
    });
    base.getBotPartAttempt = async (_uploadId, partNo) => {
      events.push(`status:${partNo}`);
      return { partNo, status: rawCalls ? 'ambiguous' : 'not_started' };
    };
    const controller = new UploadController({ file: testFile(), chunkSize, api: base });

    await expect(controller.start()).rejects.toMatchObject({ code: 'BOT_PART_ATTEMPT_AMBIGUOUS' });
    expect(rawCalls).toBe(1);
  });

  it.each(['ambiguous', 'in_progress'] as const)(
    'checks durable state after non-transient PUT failure: %s',
    async (status) => {
      const events: string[] = [];
      let putCalls = 0;
      const api = makeApi(events);
      api.getBotPartAttempt = async (_uploadId, partNo) => {
        events.push(`status:${partNo}`);
        return { partNo, status: putCalls === 0 ? 'not_started' : status };
      };
      api.uploadBotPart = async () => {
        putCalls += 1;
        throw new ApiError('INVALID_PART', 'rejected', 409);
      };
      const controller = new UploadController({
        file: new Blob([new Uint8Array([1])]) as Blob & { name: string; type: string },
        api,
        attemptPollMaxAttempts: 0,
        maxRetries: 0,
        idempotencyKey: () => 'same-key',
      });

      await expect(controller.start()).rejects.toMatchObject({
        code: status === 'ambiguous' ? 'BOT_PART_ATTEMPT_AMBIGUOUS' : 'BOT_PART_ATTEMPT_IN_PROGRESS',
      });
      expect(controller.state).toBe('blocked');
      expect(putCalls).toBe(1);
      expect(events).toContain('status:0');
    },
  );

  it('retries an in-progress part PUT with the same idempotency key after bounded polling', async () => {
    const events: string[] = [];
    const keys: string[] = [];
    let putCalls = 0;
    const api = makeApi(events);
    api.getBotPartAttempt = async (_uploadId, partNo) => {
      events.push(`status:${partNo}`);
      return { partNo, status: 'in_progress' };
    };
    api.uploadBotPart = async (_uploadId, partNo, _body, input) => {
      keys.push(input.idempotencyKey);
      putCalls += 1;
      if (putCalls === 1) throw new ApiError('LEASE_NOT_READY', 'still sending', 409);
      return { partNo, size: input.size, sha256: input.sha256 };
    };
    const controller = new UploadController({
      file: new Blob([new Uint8Array([1])]) as Blob & { name: string; type: string },
      api,
      attemptPollMaxAttempts: 1,
      attemptPollIntervalMs: 0,
      maxRetries: 1,
      sleep: vi.fn(async () => undefined),
      idempotencyKey: () => 'same-key',
    });

    await expect(controller.start()).rejects.toMatchObject({ code: 'BOT_PART_ATTEMPT_IN_PROGRESS' });
    expect(controller.state).toBe('blocked');
    await expect(controller.resumeSameUpload()).resolves.toMatchObject({ partCount: 1 });
    expect(keys).toEqual(['same-key', 'same-key']);
  });

  it('polls durable in-progress attempts and resumes the same session after explicit abandonment', async () => {
    const events: string[] = [];
    let ambiguous = false;
    let abandoned = false;
    let sends = 0;
    const base = makeApi(events, async () => {
      sends += 1;
      if (sends === 1) {
        ambiguous = true;
        throw new ApiError('UPSTREAM_FAILED', 'ambiguous', 502);
      }
    });
    base.getBotPartAttempt = async (_uploadId, partNo) => {
      events.push(`status:${partNo}`);
      if (ambiguous && !abandoned) return { partNo, status: 'ambiguous' };
      return { partNo, status: 'not_started' };
    };
    base.abandonBotPartAttempt = async (uploadId, partNo) => {
      events.push(`abandon:${uploadId}:${partNo}`);
      abandoned = true;
      return { partNo, status: 'abandoned' };
    };
    const controller = new UploadController({
      file: testFile(),
      chunkSize,
      api: base,
      attemptPollIntervalMs: 0,
      sleep: vi.fn(async () => undefined),
      idempotencyKey: (() => {
        let count = 0;
        return () => `key-${++count}`;
      })(),
    });

    await expect(controller.start()).rejects.toMatchObject({ code: 'BOT_PART_ATTEMPT_AMBIGUOUS' });
    expect(controller.state).toBe('blocked');
    expect(controller.uploadId).toBe('upload-1');
    await controller.abandonPartAttempt();
    await expect(controller.resumeSameUpload()).resolves.toMatchObject({ uploadId: 'upload-1' });
    expect(events.filter((event) => event.startsWith('start'))).toHaveLength(1);
    expect(events).toContain('abandon:upload-1:0');
  });

  it('polls in-progress status until it becomes committed without sending a duplicate', async () => {
    const events: string[] = [];
    let first = true;
    const api = makeApi(events);
    api.getBotPartAttempt = async (_uploadId, partNo) => {
      events.push(`status:${partNo}`);
      if (first) {
        first = false;
        return { partNo, status: 'in_progress' };
      }
      return { partNo, status: 'committed' };
    };
    await expect(
      new UploadController({
        file: new Blob([new Uint8Array(1)]) as Blob & { name: string; type: string },
        chunkSize,
        api,
        attemptPollIntervalMs: 0,
        sleep: vi.fn(async () => undefined),
      }).start(),
    ).resolves.toMatchObject({ partCount: 1 });
    expect(events).not.toContain('upload:0');
  });

  it('rejects files over 5 GiB before hashing or API access', async () => {
    const file = new Blob([]) as Blob & { name: string };
    Object.defineProperty(file, 'size', { value: MAX_FILE_SIZE + 1 });
    Object.defineProperty(file, 'name', { value: 'large.bin' });
    const start = vi.fn();
    const api = makeApi([]);
    api.startBotUpload = start;
    await expect(new UploadController({ file, api }).start()).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
    expect(start).not.toHaveBeenCalled();
  });
});
