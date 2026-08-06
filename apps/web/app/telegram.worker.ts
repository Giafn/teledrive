import { BaseTelegramClient, SentCode, TelegramWorker } from '@mtcute/web';
import {
  checkPassword as checkPasswordRequest,
  downloadAsBuffer,
  getMe,
  getMessages,
  logOut as logOutRequest,
  resendCode as resendCodeRequest,
  sendCode as sendCodeRequest,
  sendMedia,
  signIn as signInRequest,
} from '@mtcute/web/methods.js';
import type {
  TelegramAuthState,
  TelegramWorkerDownloadPart,
  TelegramWorkerMethods,
  TelegramWorkerUploadPart,
} from '../lib/telegram-gateway';
import { TelegramConfigurationError } from '../lib/telegram-errors';

type PendingLogin = { phone: string; phoneCodeHash: string };
const MAX_UPLOAD_CHUNK_BYTES = 19 * 1024 * 1024;

const EXPECTED_UNAUTHORIZED_ERRORS = new Set([
  'AUTH_KEY_UNREGISTERED',
  'SESSION_REVOKED',
  'USER_DEACTIVATED',
  'USER_DEACTIVATED_BAN',
]);

function readTelegramCredentials(): { apiId: number; apiHash: string } {
  const rawApiId = process.env.NEXT_PUBLIC_TELEGRAM_API_ID;
  const apiHash = process.env.NEXT_PUBLIC_TELEGRAM_API_HASH;
  const apiId = Number(rawApiId);
  if (!rawApiId || !Number.isSafeInteger(apiId) || apiId <= 0 || !apiHash) {
    throw new TelegramConfigurationError(
      'NEXT_PUBLIC_TELEGRAM_API_ID and NEXT_PUBLIC_TELEGRAM_API_HASH must be supplied by the Telegram app owner.',
    );
  }
  return { apiId, apiHash };
}

function sentCodeState(sentCode: SentCode): TelegramAuthState {
  return {
    state: 'code_sent',
    deliveryType: sentCode.type,
    nextType: sentCode.nextType,
    timeout: sentCode.timeout,
    codeLength: sentCode.length,
  };
}

function isSessionPasswordNeeded(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('text' in error)) return false;
  const text = error.text;
  return text === 'SESSION_PASSWORD_NEEDED';
}

function isExpectedUnauthorizedError(error: unknown): boolean {
  if (!(error instanceof Error) || typeof error !== 'object' || !('code' in error) || !('text' in error)) return false;
  return (
    error.constructor.name === 'RpcError' &&
    typeof error.code === 'number' &&
    typeof error.text === 'string' &&
    EXPECTED_UNAUTHORIZED_ERRORS.has(error.text)
  );
}

async function checkSession(client: BaseTelegramClient) {
  try {
    const user = await getMe(client);
    return { connected: client.isConnected, authorized: true, user: { id: user.id, displayName: user.displayName } };
  } catch (error) {
    if (isExpectedUnauthorizedError(error)) return { connected: client.isConnected, authorized: false };
    throw error;
  }
}

function requirePendingLogin(pendingLogin: PendingLogin | undefined): PendingLogin {
  if (!pendingLogin) {
    throw new TelegramConfigurationError('Call sendCode before signIn or resendCode.');
  }
  return pendingLogin;
}

function requireUploadPart(params: TelegramWorkerUploadPart) {
  if (!params.channel.trim()) throw new TelegramConfigurationError('Upload channel is required.');
  if (
    !(params.bytes instanceof Uint8Array) ||
    params.bytes.byteLength === 0 ||
    params.bytes.byteLength > MAX_UPLOAD_CHUNK_BYTES
  ) {
    throw new TelegramConfigurationError('Upload byte chunk transfer failed.');
  }
  if (!Number.isInteger(params.partNo) || params.partNo < 0) {
    throw new TelegramConfigurationError('Upload part number must be a non-negative integer.');
  }
}

async function downloadPart(client: BaseTelegramClient, params: TelegramWorkerDownloadPart) {
  if (!params.channel.trim()) throw new TelegramConfigurationError('Download channel is required.');
  if (!Number.isInteger(params.messageId) || params.messageId <= 0) {
    throw new TelegramConfigurationError('Download message ID must be a positive integer.');
  }

  const [message] = await getMessages(client, params.channel, params.messageId);
  if (!message) throw new TelegramConfigurationError('Telegram message was not found in requested channel.');

  const media = message.media;
  if (!media || media.type !== 'document') {
    throw new TelegramConfigurationError('Telegram message does not contain a downloadable document.');
  }

  const data = await downloadAsBuffer(client, media);
  const fileName = 'fileName' in media && typeof media.fileName === 'string' ? media.fileName : null;
  const mime = 'mimeType' in media && typeof media.mimeType === 'string' ? media.mimeType : null;
  return { messageId: message.id, data, fileName, mime, size: data.byteLength };
}

const { apiId, apiHash } = readTelegramCredentials();
const client = new BaseTelegramClient({
  apiId,
  apiHash,
  storage: 'teledrive.telegram.account',
  updates: false,
  logLevel: 0,
});

let pendingLogin: PendingLogin | undefined;

const customMethods: TelegramWorkerMethods = {
  async sendCode(phone) {
    if (!phone.trim()) throw new TelegramConfigurationError('Phone number is required.');
    const result = await sendCodeRequest(client, { phone });
    if (!(result instanceof SentCode)) {
      pendingLogin = undefined;
      return { state: 'authorized' };
    }
    pendingLogin = { phone, phoneCodeHash: result.phoneCodeHash };
    return sentCodeState(result);
  },
  async signIn(phoneCode) {
    if (!phoneCode.trim()) throw new TelegramConfigurationError('Confirmation code is required.');
    const pending = requirePendingLogin(pendingLogin);
    try {
      await signInRequest(client, { ...pending, phoneCode });
      pendingLogin = undefined;
      return { state: 'authorized' };
    } catch (error) {
      if (isSessionPasswordNeeded(error)) return { state: 'password_required' };
      throw error;
    }
  },
  async checkPassword(password) {
    if (!password) throw new TelegramConfigurationError('Two-step verification password is required.');
    await checkPasswordRequest(client, password);
    pendingLogin = undefined;
    return { state: 'authorized' };
  },
  async resendCode() {
    const pending = requirePendingLogin(pendingLogin);
    const result = await resendCodeRequest(client, pending);
    pendingLogin = { ...pending, phoneCodeHash: result.phoneCodeHash };
    return sentCodeState(result);
  },
  async checkConnection() {
    return checkSession(client);
  },
  async checkSession() {
    return checkSession(client);
  },
  async logOut() {
    await logOutRequest(client);
    pendingLogin = undefined;
    return { state: 'logged_out' };
  },
  async uploadPart(params) {
    requireUploadPart(params);
    const file = new File([params.bytes], params.fileName, { type: params.fileMime });
    const message = await sendMedia(client, params.channel, {
      type: 'document',
      file,
      fileName: params.fileName,
      fileMime: params.fileMime,
      fileSize: file.size,
    });
    return {
      messageId: String(message.id),
      partNo: params.partNo,
      size: file.size,
      fileName: params.fileName,
      mime: params.fileMime,
    };
  },
  async downloadPart(params) {
    return downloadPart(client, params);
  },
};

new TelegramWorker<TelegramWorkerMethods>({ client, customMethods }).mount();
