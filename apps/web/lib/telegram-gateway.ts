import type {
  checkPassword as mtcuteCheckPassword,
  resendCode as mtcuteResendCode,
  sendCode as mtcuteSendCode,
  signIn as mtcuteSignIn,
} from '@mtcute/web/methods.js';
import type { TelegramWorkerPort } from '@mtcute/web';
import { configurationReason, TelegramConfigurationError } from './telegram-errors';

export { TelegramConfigurationError } from './telegram-errors';

export type TelegramAuthState =
  | {
      state: 'code_sent';
      deliveryType: string;
      nextType: string;
      timeout: number;
      codeLength: number;
    }
  | { state: 'authorized' }
  | { state: 'password_required' }
  | { state: 'logged_out' };

export type TelegramSessionUser = { id: number; displayName: string };
export type TelegramSessionState = { connected: boolean; authorized: boolean; user?: TelegramSessionUser };
export type TelegramConnectionState = TelegramSessionState;

export type TelegramUploadResult = {
  messageId: string;
  partNo: number;
  sha256: string;
  size: number;
  fileName: string;
  mime: string;
};

export type TelegramDownloadResult = {
  messageId: number;
  data: Uint8Array;
  fileName: string | null;
  mime: string | null;
  size: number;
};

export type TelegramSendCodeParams = Parameters<typeof mtcuteSendCode>[1];
export type TelegramSignInParams = Parameters<typeof mtcuteSignIn>[1] | { phoneCode: string };
export type TelegramCheckPasswordParams = Parameters<typeof mtcuteCheckPassword>[1];
export type TelegramResendCodeParams = Parameters<typeof mtcuteResendCode>[1];

export type TelegramWorkerUploadPart = {
  channel: string;
  bytes: Uint8Array;
  partNo: number;
  fileName: string;
  fileMime: string;
};

export type TelegramWorkerDownloadPart = { channel: string; messageId: number };

export type TelegramWorkerMethods = {
  sendCode: (phone: string) => Promise<TelegramAuthState>;
  signIn: (phoneCode: string) => Promise<TelegramAuthState>;
  checkPassword: (password: string) => Promise<TelegramAuthState>;
  resendCode: () => Promise<TelegramAuthState>;
  checkSession: () => Promise<TelegramSessionState>;
  checkConnection: () => Promise<TelegramSessionState>;
  logOut: () => Promise<TelegramAuthState>;
  uploadPart: (params: TelegramWorkerUploadPart) => Promise<Omit<TelegramUploadResult, 'sha256'>>;
  downloadPart: (params: TelegramWorkerDownloadPart) => Promise<TelegramDownloadResult>;
};

export interface TelegramGateway {
  sendCode(params: TelegramSendCodeParams | string): Promise<TelegramAuthState>;
  signIn(params: TelegramSignInParams | string): Promise<TelegramAuthState>;
  checkPassword(params: TelegramCheckPasswordParams): Promise<TelegramAuthState>;
  resendCode(params?: TelegramResendCodeParams): Promise<TelegramAuthState>;
  checkSession(): Promise<TelegramSessionState>;
  checkConnection(): Promise<TelegramSessionState>;
  logOut(): Promise<TelegramAuthState>;
  logout(): Promise<TelegramAuthState>;
  uploadPart(file: Blob, partNo: number, onProgress?: (bytes: number) => void): Promise<TelegramUploadResult>;
  downloadPart(
    channel: string,
    messageId: number,
    onProgress?: (bytes: number, total: number) => void,
  ): Promise<TelegramDownloadResult>;
}

export type TelegramGatewayOptions = { channel?: string };
export const MAX_UPLOAD_CHUNK_BYTES = 19 * 1024 * 1024;

type TelegramWorkerConnection = {
  worker: Worker;
  port: TelegramWorkerPort<TelegramWorkerMethods>;
};

let connection: Promise<TelegramWorkerConnection> | undefined;

function requireBrowserTelegramConfig() {
  if (typeof window === 'undefined') {
    throw new TelegramConfigurationError('Telegram adapter can only start in a browser.');
  }

  const apiId = process.env.NEXT_PUBLIC_TELEGRAM_API_ID;
  const apiHash = process.env.NEXT_PUBLIC_TELEGRAM_API_HASH;
  const numericApiId = Number(apiId);
  if (!apiId || !Number.isSafeInteger(numericApiId) || numericApiId <= 0 || !apiHash) {
    throw new TelegramConfigurationError(
      'Set NEXT_PUBLIC_TELEGRAM_API_ID and NEXT_PUBLIC_TELEGRAM_API_HASH from the Telegram app owner.',
    );
  }
}

async function createConnection(): Promise<TelegramWorkerConnection> {
  requireBrowserTelegramConfig();
  const { TelegramWorkerPort } = await import('@mtcute/web');
  const worker = new Worker(new URL('../app/telegram.worker.ts', import.meta.url), { type: 'module' });
  const port = new TelegramWorkerPort<TelegramWorkerMethods>({ worker });
  return { worker, port };
}

function getConnection() {
  return (connection ??= createConnection());
}

const MAX_WORKER_ERROR_FIELD_LENGTH = 512;
const MAX_WORKER_ERROR_LENGTH = 1024;
const TELEGRAM_ERROR_PREFIX = '[teledrive:telegram]';

function boundedString(value: unknown, limit = MAX_WORKER_ERROR_FIELD_LENGTH): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.slice(0, limit);
}

function safeProperty(value: object, key: 'message' | 'text' | 'code'): unknown {
  try {
    return Reflect.get(value, key);
  } catch {
    return undefined;
  }
}

function safeCode(value: unknown): string | number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && Number.isSafeInteger(value)) return value;
  return boundedString(value, 64);
}

export function normalizeTelegramError(error: unknown): Error {
  if (error instanceof TelegramConfigurationError) return error;
  if (error instanceof Error) {
    const reason = configurationReason(error.message);
    if (reason) return new TelegramConfigurationError(reason);
    return error;
  }

  if (error && typeof error === 'object') {
    const message = boundedString(safeProperty(error, 'message'));
    const text = boundedString(safeProperty(error, 'text'));
    const code = safeCode(safeProperty(error, 'code'));
    const configReason = [message, text].map((value) => value && configurationReason(value)).find(Boolean);
    if (configReason) return new TelegramConfigurationError(configReason);
    const fields = [
      message,
      text && text !== message ? text : undefined,
      code === undefined ? undefined : `code ${code}`,
    ].filter((value): value is string => Boolean(value) && value !== '[object Object]');
    return new Error((fields.join(' — ') || 'Telegram worker request failed').slice(0, MAX_WORKER_ERROR_LENGTH));
  }

  const primitive = boundedString(error, MAX_WORKER_ERROR_LENGTH);
  return new Error(primitive && primitive !== '[object Object]' ? primitive : 'Telegram worker request failed');
}

function extractTelegramCode(error: unknown): string | undefined {
  const values: unknown[] = [];
  if (error instanceof Error) values.push(error.message);
  if (error && typeof error === 'object') {
    values.push(safeProperty(error, 'message'), safeProperty(error, 'text'), safeProperty(error, 'code'));
  }
  for (const value of values) {
    const text = typeof value === 'string' ? boundedString(value, MAX_WORKER_ERROR_LENGTH) : undefined;
    const match = text?.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/u);
    if (match) return match[0];
  }
  return undefined;
}

function reportCategory(error: Error, code: string | undefined): 'configuration' | 'rpc' | 'transport' | 'unknown' {
  if (error instanceof TelegramConfigurationError) return 'configuration';
  if (code) return 'rpc';
  if (error instanceof TypeError || /network|transport|connection|timeout|worker/iu.test(error.message))
    return 'transport';
  return 'unknown';
}

function configurationCode(
  error: TelegramConfigurationError,
):
  | 'WEB_API_CREDENTIALS_MISSING'
  | 'WORKER_API_CREDENTIALS_MISSING'
  | 'CHANNEL_MISSING'
  | 'BYTE_CHUNK_TRANSFER_FAILED'
  | 'INVALID_PART_NUMBER'
  | 'CONFIGURATION_UNKNOWN' {
  const reason = configurationReason(error.message);
  switch (reason) {
    case 'Set NEXT_PUBLIC_TELEGRAM_API_ID and NEXT_PUBLIC_TELEGRAM_API_HASH from the Telegram app owner.':
      return 'WEB_API_CREDENTIALS_MISSING';
    case 'NEXT_PUBLIC_TELEGRAM_API_ID and NEXT_PUBLIC_TELEGRAM_API_HASH must be supplied by the Telegram app owner.':
      return 'WORKER_API_CREDENTIALS_MISSING';
    case 'Set NEXT_PUBLIC_TELEGRAM_CHANNEL or pass channel to createTelegramGateway before uploading.':
    case 'Upload channel is required.':
    case 'Download channel is required.':
      return 'CHANNEL_MISSING';
    case 'Upload byte chunk transfer failed.':
      return 'BYTE_CHUNK_TRANSFER_FAILED';
    case 'Upload part number must be a non-negative integer.':
      return 'INVALID_PART_NUMBER';
    default:
      return 'CONFIGURATION_UNKNOWN';
  }
}

export function reportTelegramError(operation: string, error: unknown): void {
  const normalized = normalizeTelegramError(error);
  const code =
    normalized instanceof TelegramConfigurationError
      ? configurationCode(normalized)
      : (extractTelegramCode(error) ?? extractTelegramCode(normalized));
  const payload: { operation: string; category: ReturnType<typeof reportCategory>; code?: string } = {
    operation,
    category: reportCategory(normalized, code),
  };
  if (code) payload.code = code;
  console.error(TELEGRAM_ERROR_PREFIX, payload);
}

async function withTelegramReport<T>(operation: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    const normalized = normalizeTelegramError(error);
    reportTelegramError(operation, normalized);
    throw normalized;
  }
}

async function invoke<K extends keyof TelegramWorkerMethods>(
  method: K,
  ...args: Parameters<TelegramWorkerMethods[K]>
): Promise<Awaited<ReturnType<TelegramWorkerMethods[K]>>> {
  try {
    const { port } = await getConnection();
    return await port.invokeCustom(method, ...args);
  } catch (error) {
    throw normalizeTelegramError(error);
  }
}

export async function prepareTelegramUpload(
  file: Blob,
  channel: string,
  partNo: number,
  fileName: string,
  fileMime: string,
): Promise<{ payload: TelegramWorkerUploadPart; sha256: string }> {
  if (!Number.isInteger(partNo) || partNo < 0) {
    throw new TelegramConfigurationError('Upload part number must be a non-negative integer.');
  }

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    throw new TelegramConfigurationError('Upload byte chunk transfer failed.');
  }
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_UPLOAD_CHUNK_BYTES) {
    throw new TelegramConfigurationError('Upload byte chunk transfer failed.');
  }
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return {
    payload: { channel, bytes, partNo, fileName, fileMime },
    sha256: Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(''),
  };
}

function channelFrom(options: TelegramGatewayOptions): string {
  const channel = options.channel ?? process.env.NEXT_PUBLIC_TELEGRAM_CHANNEL;
  if (!channel?.trim()) {
    throw new TelegramConfigurationError(
      'Set NEXT_PUBLIC_TELEGRAM_CHANNEL or pass channel to createTelegramGateway before uploading.',
    );
  }
  return channel;
}

export function createTelegramGateway(options: TelegramGatewayOptions = {}): TelegramGateway {
  const sendCode = (params: TelegramSendCodeParams | string) =>
    withTelegramReport('sendCode', () => invoke('sendCode', typeof params === 'string' ? params : params.phone));

  const signIn = (params: TelegramSignInParams | string) =>
    withTelegramReport('signIn', () => invoke('signIn', typeof params === 'string' ? params : params.phoneCode));

  const checkPassword = (params: TelegramCheckPasswordParams) =>
    withTelegramReport('checkPassword', () =>
      invoke('checkPassword', typeof params === 'string' ? params : params.password),
    );

  const resendCode = (_params?: TelegramResendCodeParams) =>
    withTelegramReport('resendCode', () => invoke('resendCode'));
  const logOut = () => withTelegramReport('logOut', () => invoke('logOut'));

  return {
    sendCode,
    signIn,
    checkPassword,
    resendCode,
    checkConnection: () => withTelegramReport('checkConnection', () => invoke('checkConnection')),
    checkSession: () => withTelegramReport('checkSession', () => invoke('checkSession')),
    logOut,
    logout: logOut,
    uploadPart: (file, partNo, onProgress) =>
      withTelegramReport('upload', async () => {
        requireBrowserTelegramConfig();
        const channel = channelFrom(options);
        const fileName = typeof File !== 'undefined' && file instanceof File ? file.name : `part-${partNo}`;
        const mime = file.type || 'application/octet-stream';
        const prepared = await prepareTelegramUpload(file, channel, partNo, fileName, mime);
        const result = await invoke('uploadPart', prepared.payload);
        onProgress?.(file.size);
        return { ...result, sha256: prepared.sha256 };
      }),
    downloadPart: (channel, messageId, onProgress) =>
      withTelegramReport('download', async () => {
        requireBrowserTelegramConfig();
        const result = await invoke('downloadPart', { channel, messageId });
        onProgress?.(result.size, result.size);
        return result;
      }),
  };
}

export const telegramGateway: TelegramGateway = createTelegramGateway();
