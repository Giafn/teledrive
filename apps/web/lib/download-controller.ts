import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { ApiError, api, type ApiClient, type BotManifestResponse, type StoragePoolResponse } from './api';

export const MAX_PREVIEW_BYTES = 200 * 1024 * 1024;
// ponytail: Blob fallback capped at 200 MiB; FSA and StreamSaver paths stream above ceiling.
export const MAX_BLOB_FALLBACK_BYTES = MAX_PREVIEW_BYTES;
export const MAX_PART_BYTES = 19 * 1024 * 1024;
const MAX_PART_ATTEMPTS = 3;
const PART_RETRY_BASE_DELAY_MS = 100;

export type DownloadProgress = {
  phase: 'metadata' | 'downloading' | 'completed';
  bytesDownloaded: number;
  totalBytes: number;
  completedParts: number;
  totalParts: number;
};

export type PreviewResult = { url: string; mime: string; size: number; revoke: () => void };
export type SaveResult = {
  method: 'file-system-access' | 'streamsaver' | 'blob' | 'cancelled';
  name: string;
  size: number;
};
export type KnownDownloadFile = { size: number } & ({ name: string } | { filename: string });

export class DownloadError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DownloadError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

type DownloadApi = Pick<ApiClient, 'getBotManifest' | 'getBotPartContent'> &
  Partial<Pick<ApiClient, 'getStoragePool'>>;
export type DownloadControllerOptions = {
  api?: DownloadApi;
  signal?: AbortSignal;
  onProgress?: (progress: DownloadProgress) => void;
};
type FileWritable = {
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort?: (reason?: unknown) => Promise<void>;
};
type SaveFileHandle = { createWritable(): Promise<FileWritable> };
type SavePickerWindow = Window & {
  showSaveFilePicker?: (options?: { suggestedName?: string }) => Promise<SaveFileHandle>;
};
type StreamSaver = {
  supported?: boolean;
  mitm: string;
  createWriteStream: (filename: string, options?: { size?: number }) => { getWriter: () => FileWritable };
};
type PreparedDownload = { manifest: BotManifestResponse };
type SaveFilePickerInput = KnownDownloadFile | AbortSignal;

class FileSystemUnavailableError extends Error {
  constructor(readonly cause: unknown) {
    super('File System Access writable is unavailable.');
    this.name = 'FileSystemUnavailableError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

const STREAMSAVER_MITM_PATH = '/streamsaver/mitm.html';

function previewMimeSupported(mime: string): boolean {
  const normalized = mime.split(';', 1)[0].trim().toLowerCase();
  return normalized.startsWith('image/') || normalized === 'application/pdf' || normalized.startsWith('video/');
}

export function isPreviewMimeSupported(mime: string): boolean {
  return previewMimeSupported(mime);
}

function requireBrowser(): void {
  if (typeof window === 'undefined') throw new DownloadError('BROWSER_REQUIRED', 'Downloads require a browser.');
}

function streamSaverBrowserSupported(): boolean {
  const browserWindow = window as SavePickerWindow & { HTMLElement?: unknown; safari?: unknown; WebKitPoint?: unknown };
  return (
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    !('safari' in browserWindow) &&
    !('WebKitPoint' in browserWindow) &&
    !/constructor/iu.test(String(browserWindow.HTMLElement)) &&
    typeof ReadableStream !== 'undefined' &&
    typeof WritableStream !== 'undefined' &&
    typeof TransformStream !== 'undefined' &&
    typeof MessageChannel !== 'undefined'
  );
}

async function streamSaverWriter(objectName: string, objectSize: number): Promise<FileWritable | undefined> {
  if (!streamSaverBrowserSupported()) return undefined;
  try {
    const loaded = (await import('streamsaver')) as unknown as { default?: StreamSaver } & StreamSaver;
    const streamSaver = loaded.default ?? loaded;
    if (streamSaver.supported === false || typeof streamSaver.createWriteStream !== 'function') return undefined;
    streamSaver.mitm = STREAMSAVER_MITM_PATH;
    return streamSaver.createWriteStream(objectName, { size: objectSize }).getWriter();
  } catch {
    return undefined;
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DownloadError('DOWNLOAD_ABORTED', 'Download aborted.');
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return Boolean(
    value &&
    typeof value === 'object' &&
    'aborted' in value &&
    'addEventListener' in value &&
    typeof (value as { addEventListener?: unknown }).addEventListener === 'function',
  );
}

function knownName(file: KnownDownloadFile): string {
  return 'name' in file ? file.name : file.filename;
}

function isPickerAbortError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'name' in error && error.name === 'AbortError');
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const value = error as { message?: unknown; code?: unknown };
    return [value.message, value.code].filter((part): part is string => typeof part === 'string').join(' ');
  }
  return '';
}

function retryAfter(error: unknown): number | undefined {
  if (!(error instanceof ApiError)) return undefined;
  return error.retryAfter !== undefined && Number.isSafeInteger(error.retryAfter) && error.retryAfter >= 0
    ? error.retryAfter
    : undefined;
}

function isRetryablePartError(error: unknown): boolean {
  if (error instanceof DownloadError) return false;
  if (error instanceof ApiError)
    return error.status === 0 || error.status === 408 || error.status === 429 || error.status >= 500;
  return error instanceof TypeError || /network|transport|connection|timeout/iu.test(errorText(error));
}

function waitForRetry(milliseconds: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(new DownloadError('DOWNLOAD_ABORTED', 'Download aborted.'));
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function validateManifest(manifest: BotManifestResponse): BotManifestResponse['parts'] {
  if (
    !Number.isSafeInteger(manifest.object.size) ||
    manifest.object.size < 0 ||
    !Number.isSafeInteger(manifest.object.partCount) ||
    manifest.object.partCount < 0 ||
    typeof manifest.object.sha256 !== 'string' ||
    !/^[a-f\d]{64}$/iu.test(manifest.object.sha256) ||
    manifest.parts.length !== manifest.object.partCount
  ) {
    throw new DownloadError('INVALID_MANIFEST', 'Download manifest is invalid.');
  }
  const parts = [...manifest.parts].sort((left, right) => left.partNo - right.partNo);
  for (const [index, part] of parts.entries()) {
    if (
      part.partNo !== index ||
      !Number.isSafeInteger(part.size) ||
      part.size < 1 ||
      part.size > MAX_PART_BYTES ||
      typeof part.sha256 !== 'string' ||
      !/^[a-f\d]{64}$/iu.test(part.sha256)
    ) {
      throw new DownloadError('INVALID_MANIFEST', 'Download manifest is invalid.');
    }
  }
  if (parts.reduce((total, part) => total + part.size, 0) !== manifest.object.size) {
    throw new DownloadError('INVALID_MANIFEST', 'Download manifest is invalid.');
  }
  return parts;
}

export class DownloadController {
  private readonly api: DownloadApi;
  private readonly signal?: AbortSignal;
  private readonly onProgress?: (progress: DownloadProgress) => void;

  constructor(options: DownloadControllerOptions = {}) {
    this.api = options.api ?? api;
    this.signal = options.signal;
    this.onProgress = options.onProgress;
  }

  async loadPreview(objectId: string, signal = this.signal): Promise<PreviewResult> {
    requireBrowser();
    const prepared = await this.prepare(objectId, signal);
    const { object } = prepared.manifest;
    if (!previewMimeSupported(object.mime))
      throw new DownloadError('PREVIEW_UNSUPPORTED_MIME', 'This file type is download-only.');
    if (object.size > MAX_PREVIEW_BYTES)
      throw new DownloadError('PREVIEW_TOO_LARGE', 'Preview exceeds the safe 200 MiB limit.');
    const chunks = await this.downloadParts(prepared, signal, MAX_PREVIEW_BYTES, true);
    const blob = new Blob(chunks as BlobPart[], { type: object.mime });
    if (typeof URL.createObjectURL !== 'function')
      throw new DownloadError('PREVIEW_UNAVAILABLE', 'Object URL preview is unavailable.');
    const url = URL.createObjectURL(blob);
    return { url, mime: object.mime, size: object.size, revoke: () => URL.revokeObjectURL(url) };
  }

  save(objectId: string, signal?: AbortSignal): Promise<SaveResult>;
  save(objectId: string, knownFile: KnownDownloadFile, signal?: AbortSignal): Promise<SaveResult>;
  async save(
    objectId: string,
    knownOrSignal?: SaveFilePickerInput,
    requestedSignal = this.signal,
  ): Promise<SaveResult> {
    requireBrowser();
    const knownFile = knownOrSignal && !isAbortSignal(knownOrSignal) ? knownOrSignal : undefined;
    const signal = isAbortSignal(knownOrSignal) ? knownOrSignal : requestedSignal;
    const picker = (window as SavePickerWindow).showSaveFilePicker;
    let selectedHandle: SaveFileHandle | undefined;
    let pickerAttempted = false;
    if (knownFile && picker) {
      pickerAttempted = true;
      try {
        // Start picker before prepare() reaches its first network await.
        selectedHandle = await picker({ suggestedName: knownName(knownFile) });
      } catch (error) {
        if (isPickerAbortError(error)) return { method: 'cancelled', name: knownName(knownFile), size: knownFile.size };
      }
    }
    const prepared = await this.prepare(objectId, signal);
    const { object } = prepared.manifest;
    if (selectedHandle) {
      try {
        return await this.saveToFileSystem(selectedHandle, prepared, signal);
      } catch (error) {
        if (!(error instanceof FileSystemUnavailableError)) throw error;
      }
    } else if (picker && !pickerAttempted) {
      let handle: SaveFileHandle | undefined;
      try {
        handle = await picker({ suggestedName: object.name });
      } catch (error) {
        if (isPickerAbortError(error)) return { method: 'cancelled', name: object.name, size: object.size };
        // Non-cancel picker failures fall through to StreamSaver/Blob.
      }
      if (handle) {
        try {
          return await this.saveToFileSystem(handle, prepared, signal);
        } catch (error) {
          if (!(error instanceof FileSystemUnavailableError)) throw error;
        }
      }
    }

    const writer = await streamSaverWriter(object.name, object.size);
    if (writer) {
      try {
        await this.downloadParts(prepared, signal, undefined, false, (bytes) => writer.write(bytes));
        await writer.close();
        return { method: 'streamsaver', name: object.name, size: object.size };
      } catch (error) {
        try {
          await writer.abort?.(error);
        } catch {
          // Preserve original download error when cleanup fails.
        }
        throw error;
      }
    }

    if (object.size > MAX_BLOB_FALLBACK_BYTES)
      throw new DownloadError(
        'STREAMSAVER_UNAVAILABLE',
        'StreamSaver is unavailable; large downloads require a supported browser download stream.',
      );
    const chunks = await this.downloadParts(prepared, signal, MAX_BLOB_FALLBACK_BYTES, true);
    const blob = new Blob(chunks as BlobPart[], { type: object.mime });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = object.name;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    return { method: 'blob', name: object.name, size: object.size };
  }

  saveWithKnownFile(objectId: string, knownFile: KnownDownloadFile, signal = this.signal): Promise<SaveResult> {
    return this.save(objectId, knownFile, signal);
  }

  private async saveToFileSystem(
    handle: SaveFileHandle,
    prepared: PreparedDownload,
    signal: AbortSignal | undefined,
  ): Promise<SaveResult> {
    const { object } = prepared.manifest;
    let writable: FileWritable;
    try {
      writable = await handle.createWritable();
    } catch (error) {
      throw new FileSystemUnavailableError(error);
    }
    try {
      await this.downloadParts(prepared, signal, undefined, false, (bytes) => writable.write(bytes));
      await writable.close();
      return { method: 'file-system-access', name: object.name, size: object.size };
    } catch (error) {
      await writable.abort?.();
      throw error;
    }
  }

  private async prepare(objectId: string, signal?: AbortSignal): Promise<PreparedDownload> {
    throwIfAborted(signal);
    const manifest = await this.api.getBotManifest(objectId);
    validateManifest(manifest);
    this.onProgress?.({
      phase: 'metadata',
      bytesDownloaded: 0,
      totalBytes: manifest.object.size,
      completedParts: 0,
      totalParts: manifest.object.partCount,
    });
    return { manifest };
  }

  private async downloadPartWithRetry(
    objectId: string,
    partNo: number,
    signal: AbortSignal | undefined,
  ): Promise<Uint8Array> {
    for (let attempt = 1; attempt <= MAX_PART_ATTEMPTS; attempt += 1) {
      throwIfAborted(signal);
      try {
        const response = await this.api.getBotPartContent(objectId, partNo);
        return new Uint8Array(await response.arrayBuffer());
      } catch (error) {
        throwIfAborted(signal);
        if (!isRetryablePartError(error)) throw error;
        if (attempt === MAX_PART_ATTEMPTS)
          throw new DownloadError('PART_DOWNLOAD_FAILED', 'File part failed after retries.');
        const delay =
          retryAfter(error) === undefined ? PART_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1) : retryAfter(error)! * 1000;
        await waitForRetry(delay, signal);
      }
    }
    throw new DownloadError('PART_DOWNLOAD_FAILED', 'File part failed after retries.');
  }

  private async downloadParts(
    prepared: PreparedDownload,
    signal: AbortSignal | undefined,
    maxBytes: number | undefined,
    collect: boolean,
    sink?: (bytes: Uint8Array) => Promise<void>,
  ): Promise<Uint8Array[]> {
    const { manifest } = prepared;
    const parts = validateManifest(manifest);
    const objectHash = manifest.object.sha256;
    if (typeof objectHash !== 'string') throw new DownloadError('INVALID_MANIFEST', 'Download manifest is invalid.');
    if (maxBytes !== undefined && manifest.object.size > maxBytes)
      throw new DownloadError('DOWNLOAD_TOO_LARGE', 'Download exceeds the configured safe memory limit.');
    const fullHash = sha256.create();
    const chunks: Uint8Array[] = [];
    let downloaded = 0;
    let completedCount = 0;
    // Resolve concurrency from pool
    let concurrency = 1;
    if (this.api.getStoragePool) {
      try {
        const pool = await this.api.getStoragePool();
        concurrency = Math.max(1, Math.min(8, pool.botCount || 1));
      } catch {
        // ponytail: pool offline, fallback serial
      }
    }
    // Bounded parallel download
    const results = new Array<Uint8Array>(parts.length);
    let nextIdx = 0;
    const runWorker = async () => {
      while (nextIdx < parts.length) {
        const idx = nextIdx++;
        const part = parts[idx];
        throwIfAborted(signal);
        const data = await this.downloadPartWithRetry(manifest.object.id, part.partNo, signal);
        throwIfAborted(signal);
        if (data.byteLength !== part.size || data.byteLength > MAX_PART_BYTES)
          throw new DownloadError('PART_SIZE_MISMATCH', 'Downloaded part size does not match manifest.');
        if (bytesToHex(sha256(data)).toLowerCase() !== part.sha256.toLowerCase())
          throw new DownloadError('PART_HASH_MISMATCH', 'Downloaded part failed integrity validation.');
        results[idx] = data;
        downloaded += data.byteLength;
        completedCount += 1;
        this.onProgress?.({
          phase: 'downloading',
          bytesDownloaded: downloaded,
          totalBytes: manifest.object.size,
          completedParts: completedCount,
          totalParts: parts.length,
        });
      }
    };
    const workers = Array.from({ length: Math.min(concurrency, parts.length) }, runWorker);
    await Promise.all(workers);
    // Commit in order: hash, write; progress already counted per part
    for (let i = 0; i < parts.length; i++) {
      const data = results[i];
      fullHash.update(data);
      if (sink) await sink(data);
      if (collect) chunks.push(data);
    }
    if (downloaded !== manifest.object.size || bytesToHex(fullHash.digest()).toLowerCase() !== objectHash.toLowerCase())
      throw new DownloadError('OBJECT_HASH_MISMATCH', 'Downloaded object failed integrity validation.');
    this.onProgress?.({
      phase: 'completed',
      bytesDownloaded: downloaded,
      totalBytes: manifest.object.size,
      completedParts: parts.length,
      totalParts: parts.length,
    });
    return chunks;
  }
}

export function createDownloadController(options: DownloadControllerOptions = {}): DownloadController {
  return new DownloadController(options);
}
