import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { api, type ApiClient, type ManifestResponse, type ThumbnailReference } from './api';
import { telegramGateway, type TelegramDownloadResult, type TelegramGateway } from './telegram-gateway';

export const MAX_PREVIEW_BYTES = 200 * 1024 * 1024;
// ponytail: Blob fallback capped at 200 MiB; FSA and StreamSaver paths stream above ceiling.
export const MAX_BLOB_FALLBACK_BYTES = MAX_PREVIEW_BYTES;
export const MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024;
const THUMBNAIL_MIME_TYPES = new Set(['image/jpeg', 'image/webp']);
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
export type SaveResult = { method: 'file-system-access' | 'streamsaver' | 'blob'; name: string; size: number };

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

type DownloadApi = Pick<ApiClient, 'getManifest'>;
type DownloadGateway = Pick<TelegramGateway, 'checkSession' | 'downloadPart'>;
export type DownloadControllerOptions = {
  channel?: string;
  api?: DownloadApi;
  gateway?: DownloadGateway;
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
type PreparedDownload = { channel: string; manifest: ManifestResponse };

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

function errorText(error: unknown): string {
  if (error instanceof Error) {
    const value = error as Error & { text?: unknown; code?: unknown };
    return [value.message, value.text, value.code].filter((part): part is string => typeof part === 'string').join(' ');
  }
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const value = error as { message?: unknown; text?: unknown; code?: unknown };
    return [value.message, value.text, value.code].filter((part): part is string => typeof part === 'string').join(' ');
  }
  return '';
}

function floodWaitSeconds(error: unknown): number | undefined {
  const match = /\bFLOOD_WAIT_(\d+)\b/iu.exec(errorText(error));
  if (!match) return undefined;
  const seconds = Number(match[1]);
  return Number.isSafeInteger(seconds) ? seconds : undefined;
}

function isRetryablePartError(error: unknown): boolean {
  if (error instanceof DownloadError) return false;
  const text = errorText(error);
  if (
    !text ||
    /configuration|manifest|(?:part|file|object)?\s*size|hash|integrity|(?:document|file|message)[\s_]+(?:is[\s_]+)?(?:missing|not[\s_]+found)/iu.test(
      text,
    )
  ) {
    return false;
  }
  return floodWaitSeconds(error) !== undefined || /network|transport|connection|timeout|worker/iu.test(text);
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

function configuredChannel(channel?: string): string {
  const value = channel ?? process.env.NEXT_PUBLIC_TELEGRAM_CHANNEL;
  if (!value?.trim()) throw new DownloadError('CHANNEL_MISSING', 'Telegram channel is not configured.');
  return value;
}

function messageId(value: unknown): number {
  if (typeof value !== 'string' || !/^[1-9]\d*$/u.test(value)) {
    throw new DownloadError('INVALID_MESSAGE_ID', 'Download manifest contains an invalid Telegram message ID.');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new DownloadError('INVALID_MESSAGE_ID', 'Download manifest contains an invalid Telegram message ID.');
  }
  return parsed;
}

function validateManifest(manifest: ManifestResponse): ManifestResponse['parts'] {
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
      part.size < 0 ||
      typeof part.sha256 !== 'string' ||
      !/^[a-f\d]{64}$/iu.test(part.sha256)
    ) {
      throw new DownloadError('INVALID_MANIFEST', 'Download manifest is invalid.');
    }
    messageId(part.messageId);
  }
  if (parts.reduce((total, part) => total + part.size, 0) !== manifest.object.size) {
    throw new DownloadError('INVALID_MANIFEST', 'Download manifest is invalid.');
  }
  return parts;
}

export class DownloadController {
  private readonly channel?: string;
  private readonly api: DownloadApi;
  private readonly gateway: DownloadGateway;
  private readonly signal?: AbortSignal;
  private readonly onProgress?: (progress: DownloadProgress) => void;

  constructor(options: DownloadControllerOptions = {}) {
    this.channel = options.channel;
    this.api = options.api ?? api;
    this.gateway = options.gateway ?? telegramGateway;
    this.signal = options.signal;
    this.onProgress = options.onProgress;
  }

  async loadPreview(objectId: string, signal = this.signal): Promise<PreviewResult> {
    requireBrowser();
    const prepared = await this.prepare(objectId, signal);
    const { object } = prepared.manifest;
    if (!previewMimeSupported(object.mime)) {
      throw new DownloadError('PREVIEW_UNSUPPORTED_MIME', 'This file type is download-only.');
    }
    if (object.size > MAX_PREVIEW_BYTES) {
      throw new DownloadError('PREVIEW_TOO_LARGE', 'Preview exceeds the safe 200 MiB limit.');
    }
    const chunks = await this.downloadParts(prepared, signal, MAX_PREVIEW_BYTES, true);
    const blob = new Blob(chunks as BlobPart[], { type: object.mime });
    if (typeof URL.createObjectURL !== 'function')
      throw new DownloadError('PREVIEW_UNAVAILABLE', 'Object URL preview is unavailable.');
    const url = URL.createObjectURL(blob);
    return { url, mime: object.mime, size: object.size, revoke: () => URL.revokeObjectURL(url) };
  }

  async loadThumbnail(reference: ThumbnailReference, signal = this.signal): Promise<PreviewResult> {
    requireBrowser();
    throwIfAborted(signal);
    if (!THUMBNAIL_MIME_TYPES.has(reference.mime)) {
      throw new DownloadError('THUMBNAIL_UNSUPPORTED_MIME', 'Thumbnail media type is not supported.');
    }
    if (
      !Number.isSafeInteger(reference.size) ||
      reference.size < 1 ||
      reference.size > MAX_THUMBNAIL_BYTES
    ) {
      throw new DownloadError('THUMBNAIL_TOO_LARGE', 'Thumbnail exceeds the safe size limit.');
    }
    const session = await this.gateway.checkSession();
    if (!session.authorized) throw new DownloadError('TG_AUTH_REQUIRED', 'Connect Telegram before downloading.');
    throwIfAborted(signal);
    const channel = configuredChannel(this.channel);
    const result = await this.downloadPartWithRetry(channel, messageId(reference.messageId), signal, () => undefined);
    throwIfAborted(signal);
    if (!(result.data instanceof Uint8Array) || result.data.byteLength !== reference.size) {
      throw new DownloadError('PART_SIZE_MISMATCH', 'Downloaded Telegram part size does not match manifest.');
    }
    const partHash = bytesToHex(sha256(result.data));
    if (partHash.toLowerCase() !== reference.sha256.toLowerCase()) {
      throw new DownloadError('PART_HASH_MISMATCH', 'Downloaded Telegram part failed integrity validation.');
    }
    const blob = new Blob([result.data], { type: reference.mime });
    if (typeof URL.createObjectURL !== 'function')
      throw new DownloadError('PREVIEW_UNAVAILABLE', 'Object URL preview is unavailable.');
    const url = URL.createObjectURL(blob);
    return { url, mime: reference.mime, size: blob.size, revoke: () => URL.revokeObjectURL(url) };
  }

  async save(objectId: string, signal = this.signal): Promise<SaveResult> {
    requireBrowser();
    const prepared = await this.prepare(objectId, signal);
    const { object } = prepared.manifest;
    const picker = (window as SavePickerWindow).showSaveFilePicker;
    if (picker) {
      const handle = await picker({ suggestedName: object.name });
      const writable = await handle.createWritable();
      try {
        await this.downloadParts(prepared, signal, undefined, false, (bytes) => writable.write(bytes));
        await writable.close();
        return { method: 'file-system-access', name: object.name, size: object.size };
      } catch (error) {
        await writable.abort?.();
        throw error;
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

    if (object.size > MAX_BLOB_FALLBACK_BYTES) {
      throw new DownloadError(
        'STREAMSAVER_UNAVAILABLE',
        'StreamSaver is unavailable; large downloads require a supported browser download stream.',
      );
    }
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

  private async prepare(objectId: string, signal?: AbortSignal): Promise<PreparedDownload> {
    throwIfAborted(signal);
    const session = await this.gateway.checkSession();
    if (!session.authorized) throw new DownloadError('TG_AUTH_REQUIRED', 'Connect Telegram before downloading.');
    throwIfAborted(signal);
    const channel = configuredChannel(this.channel);
    const manifest = await this.api.getManifest(objectId);
    validateManifest(manifest);
    this.onProgress?.({
      phase: 'metadata',
      bytesDownloaded: 0,
      totalBytes: manifest.object.size,
      completedParts: 0,
      totalParts: manifest.object.partCount,
    });
    return { channel, manifest };
  }

  private async downloadPartWithRetry(
    channel: string,
    telegramMessageId: number,
    signal: AbortSignal | undefined,
    onProgress: (bytes: number, total: number) => void,
  ): Promise<TelegramDownloadResult> {
    for (let attempt = 1; attempt <= MAX_PART_ATTEMPTS; attempt += 1) {
      throwIfAborted(signal);
      try {
        return await this.gateway.downloadPart(channel, telegramMessageId, onProgress);
      } catch (error) {
        throwIfAborted(signal);
        if (!isRetryablePartError(error)) throw error;
        if (attempt === MAX_PART_ATTEMPTS) {
          throw new DownloadError('TG_PART_DOWNLOAD_FAILED', 'Telegram file part failed after retries.');
        }
        const floodWait = floodWaitSeconds(error);
        const delay = floodWait === undefined ? PART_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1) : floodWait * 1000;
        await waitForRetry(delay, signal);
        throwIfAborted(signal);
      }
    }
    throw new DownloadError('TG_PART_DOWNLOAD_FAILED', 'Telegram file part failed after retries.');
  }

  private async downloadParts(
    prepared: PreparedDownload,
    signal: AbortSignal | undefined,
    maxBytes: number | undefined,
    collect: boolean,
    sink?: (bytes: Uint8Array) => Promise<void>,
  ): Promise<Uint8Array[]> {
    const { channel, manifest } = prepared;
    const parts = validateManifest(manifest);
    const objectHash = manifest.object.sha256;
    if (typeof objectHash !== 'string') throw new DownloadError('INVALID_MANIFEST', 'Download manifest is invalid.');
    if (maxBytes !== undefined && manifest.object.size > maxBytes) {
      throw new DownloadError('DOWNLOAD_TOO_LARGE', 'Download exceeds the configured safe memory limit.');
    }
    const fullHash = sha256.create();
    const chunks: Uint8Array[] = [];
    let downloaded = 0;
    for (const [index, part] of parts.entries()) {
      throwIfAborted(signal);
      const result = await this.downloadPartWithRetry(channel, messageId(part.messageId), signal, (bytes) => {
        const current = Math.min(part.size, Math.max(0, bytes));
        this.onProgress?.({
          phase: 'downloading',
          bytesDownloaded: downloaded + current,
          totalBytes: manifest.object.size,
          completedParts: index,
          totalParts: parts.length,
        });
      });
      throwIfAborted(signal);
      if (!(result.data instanceof Uint8Array) || result.data.byteLength !== part.size) {
        throw new DownloadError('PART_SIZE_MISMATCH', 'Downloaded Telegram part size does not match manifest.');
      }
      const partHash = bytesToHex(sha256(result.data));
      if (partHash.toLowerCase() !== part.sha256.toLowerCase()) {
        throw new DownloadError('PART_HASH_MISMATCH', 'Downloaded Telegram part failed integrity validation.');
      }
      fullHash.update(result.data);
      if (sink) await sink(result.data);
      if (collect) chunks.push(result.data);
      downloaded += result.data.byteLength;
      this.onProgress?.({
        phase: 'downloading',
        bytesDownloaded: downloaded,
        totalBytes: manifest.object.size,
        completedParts: index + 1,
        totalParts: parts.length,
      });
    }
    if (
      downloaded !== manifest.object.size ||
      bytesToHex(fullHash.digest()).toLowerCase() !== objectHash.toLowerCase()
    ) {
      throw new DownloadError('OBJECT_HASH_MISMATCH', 'Downloaded Telegram object failed integrity validation.');
    }
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
