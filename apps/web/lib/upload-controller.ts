import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
  ApiError,
  api,
  type ApiClient,
  type BotAttemptStatus,
  type BotPart,
  type BotUploadStartInput,
  type StoragePoolResponse,
} from './api';

export const MIN_CHUNK_SIZE = 8 * 1024 * 1024;
export const DEFAULT_CHUNK_SIZE = 16 * 1024 * 1024;
export const MAX_CHUNK_SIZE = 19 * 1024 * 1024;
export const MAX_FILE_SIZE = 5 * 1024 * 1024 * 1024;
export const DEFAULT_CONCURRENCY = 1;

export class UploadCancelledError extends Error {
  constructor() {
    super('Upload cancelled');
    this.name = 'UploadCancelledError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export type UploadState =
  'idle' | 'hashing' | 'uploading' | 'paused' | 'blocked' | 'completed' | 'cancelled' | 'failed';

export type UploadErrorSignal = {
  code: string;
  message: string;
  partNo?: number;
  attemptStatus?: Extract<BotAttemptStatus['status'], 'ambiguous' | 'in_progress'>;
};

export type UploadProgress = {
  phase: UploadState;
  state: UploadState;
  bytesHashed: number;
  bytesUploaded: number;
  totalBytes: number;
  completedParts: number;
  totalParts: number;
  uploadId?: string;
  blockedPartNo?: number;
  error?: UploadErrorSignal;
};

export type UploadControllerResult = {
  uploadId: string;
  objectId: string;
  sha256: string;
  partCount: number;
  parts: BotPart[];
};

type UploadApi = Pick<
  ApiClient,
  'startBotUpload' | 'getBotPartAttempt' | 'uploadBotPart' | 'completeBotUpload' | 'abortBotUpload'
> &
  Partial<Pick<ApiClient, 'abandonBotPartAttempt' | 'getStoragePool'>>;

export type UploadQueueTask<T> = () => Promise<T>;

/** Instance-owned queue for pages that want to serialize several file controllers. */
export class UploadQueue {
  private tail = Promise.resolve();

  enqueue<T>(task: UploadQueueTask<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export function createUploadQueue(): UploadQueue {
  return new UploadQueue();
}

export type UploadControllerOptions = {
  file: Blob & { name?: string; type: string };
  folderId?: string;
  chunkSize?: number;
  /** Override pool concurrency. 0 or unset = derive from storage pool at start. */
  concurrency?: number;
  api?: UploadApi;
  idempotencyKey?: () => string;
  maxRetries?: number;
  retryDelayMs?: number;
  attemptPollIntervalMs?: number;
  attemptPollMaxAttempts?: number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  /** Test/runtime injection; production uses the dedicated bundled worker. */
  hashWorkerFactory?: () => Worker;
  onProgress?: (progress: UploadProgress) => void;
};

type PartPlan = { partNo: number; offset: number; size: number; sha256: string };
type HashWorkerResult = { type: 'result'; sha256: string; parts: PartPlan[] };
type HashWorkerProgress = { type: 'progress'; bytesHashed: number };
type HashWorkerError = { type: 'error'; message: string };
type HashWorkerMessage = HashWorkerResult | HashWorkerProgress | HashWorkerError;

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

function isTransient(error: unknown): boolean {
  if (error instanceof ApiError)
    return error.status === 0 || error.status === 408 || error.status === 429 || error.status >= 500;
  return error instanceof TypeError || /network|timeout|temporar|connection/iu.test(errorText(error));
}

function retryAfter(error: unknown): number | undefined {
  if (!(error instanceof ApiError)) return undefined;
  return error.retryAfter !== undefined && Number.isSafeInteger(error.retryAfter) && error.retryAfter >= 0
    ? error.retryAfter
    : undefined;
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

export class UploadPartAttemptError extends ApiError {
  constructor(
    readonly partNo: number,
    readonly attemptStatus: Extract<BotAttemptStatus['status'], 'ambiguous' | 'in_progress'>,
  ) {
    super(
      attemptStatus === 'ambiguous' ? 'BOT_PART_ATTEMPT_AMBIGUOUS' : 'BOT_PART_ATTEMPT_IN_PROGRESS',
      attemptStatus === 'ambiguous'
        ? 'Part delivery is ambiguous; abandon it explicitly before retrying.'
        : 'Part upload is still in progress; resume this upload to retry with the same key.',
      409,
    );
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function attemptError(
  partNo: number,
  status: Extract<BotAttemptStatus['status'], 'ambiguous' | 'in_progress'>,
): UploadPartAttemptError {
  return new UploadPartAttemptError(partNo, status);
}

function uploadErrorSignal(error: unknown): UploadErrorSignal {
  if (error instanceof UploadPartAttemptError)
    return {
      code: error.code,
      message: error.message,
      partNo: error.partNo,
      attemptStatus: error.attemptStatus,
    };
  if (error instanceof ApiError) return { code: error.code, message: error.message };
  return { code: 'UPLOAD_FAILED', message: errorText(error) || 'Upload failed' };
}

export class UploadController {
  private readonly file: UploadControllerOptions['file'];
  private readonly folderId: string | undefined;
  private readonly chunkSize: number;
  private readonly api: UploadApi;
  private readonly idempotencyKey: () => string;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly attemptPollIntervalMs: number;
  private readonly attemptPollMaxAttempts: number;
  private readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  private readonly hashWorkerFactory: (() => Worker) | undefined;
  private readonly onProgress?: (progress: UploadProgress) => void;
  private readonly abortController = new AbortController();
  private readonly partProgress = new Map<number, number>();
  private readonly committed = new Set<number>();
  private readonly committedParts = new Map<number, BotPart>();
  private readonly partKeys = new Map<number, string>();
  private readonly resumeWaiters: Array<() => void> = [];
  private runPromise: Promise<UploadControllerResult> | undefined;
  private abortPromise: Promise<void> | undefined;
  private hashWorker: Worker | undefined;
  private hashWorkerReject: ((reason: unknown) => void) | undefined;
  private sessionId: string | undefined;
  private manifest: { sha256: string; parts: PartPlan[] } | undefined;
  private paused = false;
  private cancelled = false;
  private bytesHashed = 0;
  private totalParts = 0;
  private currentState: UploadState = 'idle';
  private activePhase: 'hashing' | 'uploading' = 'hashing';
  private lastError: UploadErrorSignal | undefined;
  private blockedPartNo: number | undefined;
  private blockedAttemptStatus: Extract<BotAttemptStatus['status'], 'ambiguous' | 'in_progress'> | undefined;
  private readyToResumeSameUpload = false;
  private resolvedConcurrency: number;

  constructor(options: UploadControllerOptions) {
    this.file = options.file;
    this.folderId = options.folderId;
    this.chunkSize = validateInteger(
      options.chunkSize ?? DEFAULT_CHUNK_SIZE,
      MIN_CHUNK_SIZE,
      MAX_CHUNK_SIZE,
      'chunkSize',
    );
    this.api = options.api ?? api;
    this.idempotencyKey = options.idempotencyKey ?? randomKey;
    this.maxRetries = validateInteger(options.maxRetries ?? 3, 0, 10, 'maxRetries');
    this.retryDelayMs = validateInteger(options.retryDelayMs ?? 500, 0, 60_000, 'retryDelayMs');
    this.attemptPollIntervalMs = validateInteger(
      options.attemptPollIntervalMs ?? this.retryDelayMs,
      0,
      60_000,
      'attemptPollIntervalMs',
    );
    this.attemptPollMaxAttempts = validateInteger(
      options.attemptPollMaxAttempts ?? 60,
      0,
      600,
      'attemptPollMaxAttempts',
    );
    this.sleep = options.sleep ?? defaultSleep;
    this.hashWorkerFactory = options.hashWorkerFactory;
    this.onProgress = options.onProgress;
    this.resolvedConcurrency = validateInteger(options.concurrency ?? 1, 1, 32, 'concurrency');
  }

  get uploadId(): string | undefined {
    return this.sessionId;
  }

  get state(): UploadState {
    return this.currentState;
  }

  getState(): UploadState {
    return this.currentState;
  }

  get snapshot(): UploadProgress {
    return this.progressSnapshot(this.state);
  }

  start(): Promise<UploadControllerResult> {
    if (!this.runPromise) this.runPromise = this.run();
    return this.runPromise;
  }

  pause(): void {
    if (this.cancelled || this.state === 'completed' || this.state === 'failed') return;
    this.paused = true;
    this.hashWorker?.postMessage({ type: 'pause' });
    this.emit('paused');
  }

  resume(): void {
    if (this.cancelled || this.state === 'blocked') return;
    this.paused = false;
    this.hashWorker?.postMessage({ type: 'resume' });
    if (this.state === 'paused') {
      this.currentState = this.activePhase;
      this.emit(this.activePhase);
    }
    while (this.resumeWaiters.length) this.resumeWaiters.shift()?.();
  }

  /** Abandons only an ambiguous durable attempt. It never creates a new session. */
  async abandonPartAttempt(partNo = this.blockedPartNo): Promise<BotAttemptStatus & { consequence?: string }> {
    if (!this.sessionId || partNo === undefined || this.blockedPartNo !== partNo)
      throw new ApiError('UPLOAD_PART_NOT_BLOCKED', 'No matching blocked upload part is available.', 409);
    if (this.blockedAttemptStatus !== 'ambiguous')
      throw new ApiError('BOT_PART_ATTEMPT_NOT_AMBIGUOUS', 'Only ambiguous attempts can be abandoned.', 409);
    if (!this.api.abandonBotPartAttempt)
      throw new ApiError('UPLOAD_ABANDON_UNAVAILABLE', 'Upload attempt abandonment is unavailable.', 501);
    const result = await this.api.abandonBotPartAttempt(this.sessionId, partNo);
    if (result.status !== 'abandoned')
      throw new ApiError(
        'BOT_PART_ATTEMPT_STATE_CHANGED',
        'Part attempt state changed; check status before resuming.',
        409,
      );
    this.blockedPartNo = undefined;
    this.blockedAttemptStatus = undefined;
    this.readyToResumeSameUpload = true;
    this.lastError = undefined;
    this.currentState = 'paused';
    this.emit('paused');
    return result;
  }

  /** Continues existing manifest/session after explicit abandonment. */
  resumeSameUpload(): Promise<UploadControllerResult> {
    if (this.cancelled) return Promise.reject(new UploadCancelledError());
    if (!this.sessionId || !this.manifest)
      return Promise.reject(new ApiError('UPLOAD_SESSION_REQUIRED', 'No upload session is available to resume.', 409));
    if (this.state !== 'blocked' && !this.readyToResumeSameUpload)
      return Promise.reject(
        new ApiError('UPLOAD_NOT_BLOCKED', 'Upload is not waiting on a durable part attempt.', 409),
      );
    if (this.blockedAttemptStatus === 'ambiguous')
      return Promise.reject(
        new ApiError('BOT_PART_ATTEMPT_ABANDON_REQUIRED', 'Abandon ambiguous part attempt before resuming.', 409),
      );
    this.blockedPartNo = undefined;
    this.blockedAttemptStatus = undefined;
    this.readyToResumeSameUpload = false;
    this.lastError = undefined;
    this.paused = false;
    this.currentState = 'uploading';
    this.runPromise = this.continueExistingUpload();
    return this.runPromise;
  }

  /** Alias suitable for page controllers that distinguish pause from durable resume. */
  resumeUpload(): Promise<UploadControllerResult> {
    return this.resumeSameUpload();
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
    this.abortController.abort();
    const worker = this.hashWorker;
    const rejectWorker = this.hashWorkerReject;
    if (worker && rejectWorker) {
      worker.terminate();
      rejectWorker(new UploadCancelledError());
    }
    while (this.resumeWaiters.length) this.resumeWaiters.shift()?.();
    if (!this.runPromise) {
      this.emit('cancelled');
      return;
    }
    if (this.state === 'blocked') {
      await this.abortSession().catch(() => undefined);
      this.emit('cancelled');
      return;
    }
    try {
      await this.runPromise;
    } catch (error) {
      if (!(error instanceof UploadCancelledError)) throw error;
    }
  }

  private progressSnapshot(phase: UploadState): UploadProgress {
    let bytesUploaded = 0;
    for (const bytes of this.partProgress.values()) bytesUploaded += bytes;
    return {
      phase,
      state: this.state,
      bytesHashed: this.bytesHashed,
      bytesUploaded,
      totalBytes: this.file.size,
      completedParts: this.committed.size,
      totalParts: this.totalParts,
      ...(this.sessionId ? { uploadId: this.sessionId } : {}),
      ...(this.blockedPartNo === undefined ? {} : { blockedPartNo: this.blockedPartNo }),
      ...(this.lastError ? { error: this.lastError } : {}),
    };
  }

  private emit(phase: UploadState): void {
    if (phase === 'hashing' || phase === 'uploading') {
      this.activePhase = phase;
      if (this.currentState !== 'paused' && this.currentState !== 'blocked') this.currentState = phase;
    } else {
      this.currentState = phase;
    }
    this.onProgress?.(this.progressSnapshot(this.state));
  }

  private async waitUntilRunnable(): Promise<void> {
    if (this.cancelled) throw new UploadCancelledError();
    if (!this.paused) return;
    await new Promise<void>((resolve) => this.resumeWaiters.push(resolve));
    if (this.cancelled) throw new UploadCancelledError();
  }

  private createHashWorker(): Worker | undefined {
    if (this.hashWorkerFactory) {
      try {
        return this.hashWorkerFactory();
      } catch {
        return undefined;
      }
    }
    if (typeof Worker === 'undefined') return undefined;
    try {
      return new Worker(new URL('./upload-hasher.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      return undefined;
    }
  }

  private async hashFile(): Promise<{ sha256: string; parts: PartPlan[] }> {
    this.totalParts = partCountFor(this.file.size, this.chunkSize);
    this.bytesHashed = 0;
    this.emit('hashing');
    const worker = this.createHashWorker();
    if (worker) return this.hashFileInWorker(worker);
    return this.hashFileOnMainThread();
  }

  private hashFileInWorker(worker: Worker): Promise<{ sha256: string; parts: PartPlan[] }> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        worker.onmessage = null;
        worker.onerror = null;
        worker.terminate();
        if (this.hashWorker === worker) this.hashWorker = undefined;
        if (this.hashWorkerReject) this.hashWorkerReject = undefined;
        callback();
      };
      this.hashWorker = worker;
      this.hashWorkerReject = (reason) => finish(() => reject(reason));
      worker.onmessage = (event: MessageEvent<HashWorkerMessage>) => {
        const message = event.data;
        if (message.type === 'progress') {
          if (Number.isSafeInteger(message.bytesHashed) && message.bytesHashed >= this.bytesHashed)
            this.bytesHashed = message.bytesHashed;
          this.emit('hashing');
        } else if (message.type === 'result') {
          this.bytesHashed = this.file.size;
          finish(() => resolve({ sha256: message.sha256, parts: message.parts }));
        } else {
          finish(() => reject(new Error(message.message || 'Upload hashing worker failed')));
        }
      };
      worker.onerror = (event) => finish(() => reject(new Error(event.message || 'Upload hashing worker failed')));
      try {
        worker.postMessage({ type: 'hash', file: this.file, chunkSize: this.chunkSize, paused: this.paused });
      } catch (error) {
        finish(() => reject(error));
      }
    });
  }

  private async hashFileOnMainThread(): Promise<{ sha256: string; parts: PartPlan[] }> {
    const fullHash = sha256.create();
    const parts: PartPlan[] = [];
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
        if (!isTransient(error) || attempt >= this.maxRetries) throw error;
        await this.sleep(
          (retryAfter(error) ?? 0) * 1000 || this.retryDelayMs * 2 ** attempt,
          this.abortController.signal,
        );
        attempt += 1;
      }
    }
  }

  private async abortSession(): Promise<void> {
    if (!this.sessionId || this.abortPromise) return this.abortPromise ?? Promise.resolve();
    const sessionId = this.sessionId;
    this.abortPromise = this.api.abortBotUpload(sessionId).then(() => undefined);
    return this.abortPromise;
  }

  private async currentAttempt(partNo: number): Promise<BotAttemptStatus> {
    let state = await this.retry(() => this.api.getBotPartAttempt(this.sessionId as string, partNo));
    let polls = 0;
    while (state.status === 'in_progress') {
      if (polls >= this.attemptPollMaxAttempts) return state;
      await this.sleep(this.attemptPollIntervalMs, this.abortController.signal);
      state = await this.retry(() => this.api.getBotPartAttempt(this.sessionId as string, partNo));
      polls += 1;
    }
    return state;
  }

  private markCommitted(plan: PartPlan, part: BotPart): void {
    if (
      part.partNo !== plan.partNo ||
      part.size !== plan.size ||
      part.sha256.toLowerCase() !== plan.sha256.toLowerCase()
    )
      throw new ApiError('PART_IDEMPOTENCY_CONFLICT', `Existing part ${plan.partNo} does not match file`, 409);
    this.partProgress.set(plan.partNo, plan.size);
    this.committed.add(plan.partNo);
    this.committedParts.set(plan.partNo, part);
    this.emit('uploading');
  }

  private async uploadPart(plan: PartPlan): Promise<void> {
    let key = this.partKeys.get(plan.partNo) ?? this.idempotencyKey();
    this.partKeys.set(plan.partNo, key);
    let retryAttempt = 0;
    while (true) {
      const state = await this.currentAttempt(plan.partNo);
      if (state.status === 'committed') {
        this.markCommitted(plan, { partNo: plan.partNo, size: plan.size, sha256: plan.sha256 });
        return;
      }
      if (state.status === 'ambiguous') throw attemptError(plan.partNo, state.status);
      if (state.status === 'abandoned') {
        key = this.idempotencyKey();
        this.partKeys.set(plan.partNo, key);
      }

      const chunk = this.file.slice(plan.offset, plan.offset + plan.size);
      this.partProgress.set(plan.partNo, 0);
      try {
        const committed = await this.api.uploadBotPart(this.sessionId as string, plan.partNo, chunk, {
          size: plan.size,
          sha256: plan.sha256,
          idempotencyKey: key,
        });
        this.markCommitted(plan, committed);
        return;
      } catch (error) {
        if (this.cancelled) throw new UploadCancelledError();

        // Every PUT failure gets a durable read before ordinary error handling.
        const afterError = await this.currentAttempt(plan.partNo);
        if (afterError.status === 'committed') {
          this.markCommitted(plan, { partNo: plan.partNo, size: plan.size, sha256: plan.sha256 });
          return;
        }
        if (afterError.status === 'ambiguous') throw attemptError(plan.partNo, afterError.status);
        if (afterError.status === 'in_progress') throw attemptError(plan.partNo, afterError.status);
        if (!isTransient(error)) throw error;
        if (retryAttempt >= this.maxRetries) throw error;
        const wait = retryAfter(error);
        if (wait !== undefined) await this.sleep(wait * 1000, this.abortController.signal);
        if (afterError.status === 'abandoned') {
          key = this.idempotencyKey();
          this.partKeys.set(plan.partNo, key);
        }
        if (wait === undefined) await this.sleep(this.retryDelayMs * 2 ** retryAttempt, this.abortController.signal);
        retryAttempt += 1;
      }
    }
  }

  private async completeUpload(manifest: { sha256: string; parts: PartPlan[] }): Promise<UploadControllerResult> {
    await this.waitUntilRunnable();
    this.emit('uploading');
    const concurrency = this.resolvedConcurrency;
    let nextIdx = 0;
    const runWorker = async () => {
      while (nextIdx < manifest.parts.length) {
        const idx = nextIdx++;
        const plan = manifest.parts[idx];
        await this.waitUntilRunnable();
        if (!this.committed.has(plan.partNo)) await this.uploadPart(plan);
      }
    };
    const workers = Array.from({ length: Math.min(concurrency, manifest.parts.length) }, runWorker);
    await Promise.all(workers);
    if (this.committed.size !== manifest.parts.length)
      throw new ApiError('MANIFEST_INVALID', 'Every upload part must be committed before complete', 422);
    const completed = await this.retry(() =>
      this.api.completeBotUpload(this.sessionId as string, {
        partCount: manifest.parts.length,
        size: this.file.size,
        sha256: manifest.sha256,
      }),
    );
    this.lastError = undefined;
    this.emit('completed');
    return {
      uploadId: this.sessionId as string,
      objectId: completed.objectId,
      sha256: manifest.sha256,
      partCount: manifest.parts.length,
      parts: [...this.committedParts.values()].sort((left, right) => left.partNo - right.partNo),
    };
  }

  private async handleRunError(error: unknown): Promise<never> {
    if (this.cancelled) {
      await this.abortSession().catch(() => undefined);
      this.emit('cancelled');
      throw new UploadCancelledError();
    }
    this.lastError = uploadErrorSignal(error);
    if (error instanceof UploadPartAttemptError) {
      this.blockedPartNo = error.partNo;
      this.blockedAttemptStatus = error.attemptStatus;
      this.readyToResumeSameUpload = false;
      this.emit('blocked');
    } else this.emit('failed');
    throw error;
  }

  private async continueExistingUpload(): Promise<UploadControllerResult> {
    try {
      return await this.completeUpload(this.manifest as { sha256: string; parts: PartPlan[] });
    } catch (error) {
      return this.handleRunError(error);
    }
  }

  private async run(): Promise<UploadControllerResult> {
    try {
      if (this.file.size > MAX_FILE_SIZE)
        throw new ApiError('FILE_TOO_LARGE', 'Files larger than 5 GiB are not supported.', 413);
      this.manifest = await this.hashFile();
      await this.waitUntilRunnable();
      // Resolve concurrency from pool if not explicitly set via options
      if (this.resolvedConcurrency <= 1 && this.api.getStoragePool) {
        try {
          const pool = await this.api.getStoragePool();
          this.resolvedConcurrency = Math.max(1, Math.min(pool.botCount || 1, 8));
        } catch {
          // ponytail: pool offline, fallback serial
        }
      }
      const startMetadata: BotUploadStartInput = {
        name: this.file.name ?? 'unnamed',
        size: this.file.size,
        mime: this.file.type || 'application/octet-stream',
        folderId: this.folderId,
        chunkSize: this.chunkSize,
        partCount: this.manifest.parts.length,
        sha256: this.manifest.sha256,
        idempotencyKey: this.idempotencyKey(),
      };
      const session = await this.retry(() => this.api.startBotUpload(startMetadata));
      this.sessionId = session.id;
      return await this.completeUpload(this.manifest);
    } catch (error) {
      return this.handleRunError(error);
    }
  }
}

export function createUploadController(options: UploadControllerOptions): UploadController {
  return new UploadController(options);
}
