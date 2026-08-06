import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { ApiError, api, type ApiClient, type UploadPart, type UploadStartInput } from './api';
import { telegramGateway, type TelegramGateway, type TelegramUploadResult } from './telegram-gateway';

export const MIN_CHUNK_SIZE = 8 * 1024 * 1024;
export const DEFAULT_CHUNK_SIZE = 16 * 1024 * 1024;
export const MAX_CHUNK_SIZE = 19 * 1024 * 1024;
export const DEFAULT_CONCURRENCY = 3;

export class UploadCancelledError extends Error {
  constructor() {
    super('Upload cancelled');
    this.name = 'UploadCancelledError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export type UploadProgress = {
  phase: 'hashing' | 'uploading' | 'paused' | 'completed' | 'cancelled';
  bytesHashed: number;
  bytesUploaded: number;
  totalBytes: number;
  completedParts: number;
  totalParts: number;
};

export type UploadControllerResult = {
  uploadId: string;
  objectId: string;
  sha256: string;
  partCount: number;
  parts: UploadPart[];
};

type UploadGateway = Pick<TelegramGateway, 'checkSession' | 'uploadPart'>;
type TelegramGatewayUploadPart = (
  file: Blob,
  partNo: number,
  onProgress?: (bytes: number) => void,
) => Promise<TelegramUploadResult>;

export type UploadControllerOptions = {
  file: Blob & { name?: string; type: string };
  folderId?: string;
  chunkSize?: number;
  concurrency?: number;
  api?: ApiClient;
  gateway?: UploadGateway;
  idempotencyKey?: () => string;
  maxRetries?: number;
  retryDelayMs?: number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  onProgress?: (progress: UploadProgress) => void;
};

type PartPlan = { partNo: number; offset: number; size: number; sha256: string };

function validateInteger(value: number, min: number, max: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError(`${name} is out of range`);
  return value;
}

function partCountFor(size: number, chunkSize: number): number {
  return size === 0 ? 0 : Math.ceil(size / chunkSize);
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string')
    return error.message;
  return '';
}

function floodWaitSeconds(error: unknown): number | null | undefined {
  const textValue =
    typeof error === 'object' && error !== null && 'text' in error && typeof error.text === 'string' ? error.text : '';
  const text = `${textValue} ${errorText(error)}`;
  const match = /FLOOD_WAIT(?:_(\d+))?/iu.exec(text);
  if (!match) return undefined;
  return match[1] === undefined ? null : Number(match[1]);
}

function isTransient(error: unknown): boolean {
  if (error instanceof ApiError)
    return error.status === 0 || error.status === 408 || error.status === 429 || error.status >= 500;
  return error instanceof TypeError || /network|timeout|temporar|connection/iu.test(errorText(error));
}

function randomKey(): string {
  if (!globalThis.crypto?.randomUUID) throw new Error('Web Crypto randomUUID is required for upload idempotency keys');
  return globalThis.crypto.randomUUID();
}

function defaultSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new UploadCancelledError());
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new UploadCancelledError());
      },
      { once: true },
    );
  });
}

export class UploadController {
  private readonly file: UploadControllerOptions['file'];
  private readonly folderId: string | undefined;
  private readonly chunkSize: number;
  private readonly concurrency: number;
  private readonly api: ApiClient;
  private readonly gateway: UploadGateway;
  private readonly idempotencyKey: () => string;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  private readonly onProgress?: (progress: UploadProgress) => void;
  private readonly abortController = new AbortController();
  private readonly partProgress = new Map<number, number>();
  private readonly committed = new Set<number>();
  private readonly resumeWaiters: Array<() => void> = [];
  private runPromise: Promise<UploadControllerResult> | undefined;
  private abortPromise: Promise<void> | undefined;
  private sessionId: string | undefined;
  private paused = false;
  private cancelled = false;
  private bytesHashed = 0;
  private totalParts = 0;

  constructor(options: UploadControllerOptions) {
    this.file = options.file;
    this.folderId = options.folderId;
    this.chunkSize = validateInteger(
      options.chunkSize ?? DEFAULT_CHUNK_SIZE,
      MIN_CHUNK_SIZE,
      MAX_CHUNK_SIZE,
      'chunkSize',
    );
    this.concurrency = validateInteger(options.concurrency ?? DEFAULT_CONCURRENCY, 1, 4, 'concurrency');
    this.api = options.api ?? api;
    this.gateway = options.gateway ?? telegramGateway;
    this.idempotencyKey = options.idempotencyKey ?? randomKey;
    this.maxRetries = validateInteger(options.maxRetries ?? 3, 0, 10, 'maxRetries');
    this.retryDelayMs = validateInteger(options.retryDelayMs ?? 500, 0, 60_000, 'retryDelayMs');
    this.sleep = options.sleep ?? defaultSleep;
    this.onProgress = options.onProgress;
  }

  start(): Promise<UploadControllerResult> {
    if (!this.runPromise) this.runPromise = this.run();
    return this.runPromise;
  }

  pause(): void {
    if (this.cancelled) return;
    this.paused = true;
    this.emit('paused');
  }

  resume(): void {
    if (this.cancelled) return;
    this.paused = false;
    while (this.resumeWaiters.length) this.resumeWaiters.shift()?.();
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
    this.abortController.abort();
    while (this.resumeWaiters.length) this.resumeWaiters.shift()?.();
    if (!this.runPromise) {
      this.emit('cancelled');
      return;
    }
    try {
      await this.runPromise;
    } catch (error) {
      if (!(error instanceof UploadCancelledError)) throw error;
    }
  }

  private emit(phase: UploadProgress['phase']): void {
    if (!this.onProgress) return;
    let bytesUploaded = 0;
    for (const bytes of this.partProgress.values()) bytesUploaded += bytes;
    this.onProgress({
      phase,
      bytesHashed: this.bytesHashed,
      bytesUploaded,
      totalBytes: this.file.size,
      completedParts: this.committed.size,
      totalParts: this.totalParts,
    });
  }

  private async waitUntilRunnable(): Promise<void> {
    if (this.cancelled) throw new UploadCancelledError();
    if (!this.paused) return;
    await new Promise<void>((resolve) => this.resumeWaiters.push(resolve));
    if (this.cancelled) throw new UploadCancelledError();
  }

  private async hashFile(): Promise<{ sha256: string; parts: PartPlan[] }> {
    const fullHash = sha256.create();
    const parts: PartPlan[] = [];
    this.totalParts = partCountFor(this.file.size, this.chunkSize);
    this.emit('hashing');
    for (let partNo = 0; partNo < this.totalParts; partNo += 1) {
      await this.waitUntilRunnable();
      const offset = partNo * this.chunkSize;
      const chunk = this.file.slice(offset, Math.min(this.file.size, offset + this.chunkSize));
      const bytes = new Uint8Array(await chunk.arrayBuffer());
      fullHash.update(bytes);
      parts.push({ partNo, offset, size: bytes.byteLength, sha256: bytesToHex(sha256(bytes)) });
      this.bytesHashed += bytes.byteLength;
      this.emit('hashing');
    }
    return { sha256: bytesToHex(fullHash.digest()), parts };
  }

  private async retry<T>(operation: () => Promise<T>): Promise<T> {
    let attempt = 0;
    while (true) {
      if (this.cancelled) throw new UploadCancelledError();
      try {
        return await operation();
      } catch (error) {
        if (this.cancelled) throw new UploadCancelledError();
        const flood = floodWaitSeconds(error);
        if (flood === null) throw error;
        if (flood === undefined && !isTransient(error)) throw error;
        if (attempt >= this.maxRetries) throw error;
        const wait = flood === undefined ? this.retryDelayMs * 2 ** attempt : flood * 1000;
        await this.sleep(wait, this.abortController.signal);
        attempt += 1;
      }
    }
  }

  private async abortSession(): Promise<void> {
    if (!this.sessionId || this.abortPromise) return this.abortPromise ?? Promise.resolve();
    const sessionId = this.sessionId;
    this.abortPromise = this.api.abortUpload(sessionId).then(() => undefined);
    return this.abortPromise;
  }

  private async uploadAndCommit(plan: PartPlan, existing: Map<number, UploadPart>): Promise<void> {
    const known = existing.get(plan.partNo);
    if (known) {
      if (known.size !== plan.size || known.sha256 !== plan.sha256) {
        throw new ApiError('PART_IDEMPOTENCY_CONFLICT', `Existing part ${plan.partNo} does not match file`, 409);
      }
      this.partProgress.set(plan.partNo, plan.size);
      this.committed.add(plan.partNo);
      this.emit('uploading');
      return;
    }

    const chunk = this.file.slice(plan.offset, plan.offset + plan.size);
    this.partProgress.set(plan.partNo, 0);
    const partIdempotencyKey = this.idempotencyKey();
    const telegramResult = await this.retry(() =>
      this.gateway.uploadPart(chunk, plan.partNo, (bytes) => {
        this.partProgress.set(plan.partNo, Math.min(plan.size, Math.max(0, bytes)));
        this.emit('uploading');
      }),
    );
    if (this.cancelled) throw new UploadCancelledError();
    const committed = await this.retry(() =>
      this.api.commitPart(this.sessionId as string, {
        partNo: plan.partNo,
        size: plan.size,
        sha256: plan.sha256,
        messageId: telegramResult.messageId,
        idempotencyKey: partIdempotencyKey,
      }),
    );
    this.partProgress.set(plan.partNo, plan.size);
    this.committed.add(plan.partNo);
    existing.set(plan.partNo, committed);
    this.emit('uploading');
  }

  private async run(): Promise<UploadControllerResult> {
    const active = new Set<Promise<void>>();
    try {
      const sessionState = await this.gateway.checkSession();
      if (!sessionState.authorized) throw new ApiError('TG_AUTH_REQUIRED', 'Connect Telegram before uploading.', 401);
      const manifest = await this.hashFile();
      await this.waitUntilRunnable();
      const folderId = this.folderId ?? (await this.retry(() => this.api.getWorkspace())).rootFolder.id;
      const startMetadata: UploadStartInput = {
        name: this.file.name ?? 'unnamed',
        size: this.file.size,
        mime: this.file.type || 'application/octet-stream',
        folderId,
        chunkSize: this.chunkSize,
        partCount: manifest.parts.length,
        sha256: manifest.sha256,
        idempotencyKey: this.idempotencyKey(),
      };
      const session = await this.retry(() => this.api.startUpload(startMetadata));
      this.sessionId = session.id;
      const detail = await this.retry(() => this.api.getUpload(session.id));
      const existing = new Map(detail.parts.map((part) => [part.partNo, part]));
      for (const part of existing.values()) {
        const plan = manifest.parts[part.partNo];
        if (plan && plan.size === part.size && plan.sha256 === part.sha256) {
          this.partProgress.set(part.partNo, part.size);
          this.committed.add(part.partNo);
        }
      }
      this.emit('uploading');

      let nextPart = 0;
      while (nextPart < manifest.parts.length) {
        await this.waitUntilRunnable();
        const plan = manifest.parts[nextPart];
        nextPart += 1;
        let task: Promise<void>;
        task = this.uploadAndCommit(plan, existing).finally(() => active.delete(task));
        active.add(task);
        if (active.size >= this.concurrency) await Promise.race(active);
      }
      await Promise.all(active);
      if (this.committed.size !== manifest.parts.length)
        throw new ApiError('MANIFEST_INVALID', 'Every upload part must be committed before complete', 422);
      const completed = await this.retry(() =>
        this.api.completeUpload(session.id, {
          partCount: manifest.parts.length,
          size: this.file.size,
          sha256: manifest.sha256,
        }),
      );
      this.emit('completed');
      return {
        uploadId: session.id,
        objectId: completed.objectId,
        sha256: manifest.sha256,
        partCount: manifest.parts.length,
        parts: [...existing.values()].sort((a, b) => a.partNo - b.partNo),
      };
    } catch (error) {
      await Promise.allSettled(active);
      if (this.cancelled) {
        await this.abortSession();
        this.emit('cancelled');
        throw new UploadCancelledError();
      }
      throw error;
    }
  }
}

export function createUploadController(options: UploadControllerOptions): UploadController {
  return new UploadController(options);
}
