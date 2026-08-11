import type { Api, TelegramClient } from 'telegram';

/**
 * Client-only Phase 2 proof. Load this module from client UI with a dynamic
 * import; it intentionally has no runtime Telegram import at module scope.
 */

export const MT_PROTO_SPIKE_MAX_FILE_BYTES = 10 * 1024 * 1024;

export class MtprotoSpikeError extends Error {
  override name = 'MtprotoSpikeError';

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

export interface MtprotoSpikePrompts {
  phoneNumber?: () => Promise<string>;
  phoneCode?: (isCodeViaApp?: boolean) => Promise<string>;
  password?: (hint?: string) => Promise<string>;
}

export interface MtprotoSpikeOptions {
  apiId: number;
  apiHash: string;
  prompts?: MtprotoSpikePrompts;
  maxFileBytes?: number;
}

export interface MtprotoUser {
  id: string;
  username?: string;
  firstName?: string;
  lastName?: string;
}

export interface MtprotoChannel {
  id: string;
  title: string;
  username?: string;
  isPrivate: boolean;
  isBroadcast: boolean;
  isMegagroup: boolean;
}

export interface MtprotoMessageRef {
  channelId: string;
  messageId: number;
  documentId: string;
  fileName: string;
  mimeType: string;
  size: number;
}

export interface MtprotoDocumentReceipt extends MtprotoMessageRef {
  sha256: string;
}

export interface MtprotoDownloadVerification {
  receipt: MtprotoDocumentReceipt;
  downloadedSize: number;
  downloadedSha256: string;
  bytes: Uint8Array;
  verified: true;
}

type TelegramRuntime = typeof import('telegram');
type ChannelSelection = {
  channel: MtprotoChannel;
  inputEntity: Api.TypeInputPeer;
};

type BrowserStorageSnapshot = {
  name: 'localStorage' | 'sessionStorage';
  descriptor?: PropertyDescriptor;
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireBrowserPrerequisites(): void {
  if (typeof window === 'undefined') {
    throw new MtprotoSpikeError('MTProto spike requires browser client runtime');
  }
  if (typeof window.prompt !== 'function') {
    throw new MtprotoSpikeError('MTProto spike requires browser prompt support');
  }
  if (typeof WebSocket !== 'function') {
    throw new MtprotoSpikeError('MTProto spike requires native WebSocket support');
  }
  if (
    typeof File !== 'function' ||
    typeof File.prototype.arrayBuffer !== 'function' ||
    typeof Response !== 'function' ||
    typeof Response.prototype.arrayBuffer !== 'function'
  ) {
    throw new MtprotoSpikeError('MTProto spike requires DOM File and Response support');
  }
  if (typeof globalThis.crypto?.subtle?.digest !== 'function') {
    throw new MtprotoSpikeError('MTProto spike requires Web Crypto SHA-256 support');
  }
}

function hideBrowserStorage(): () => void {
  const snapshots: BrowserStorageSnapshot[] = [];
  const globalObject = globalThis as Record<string, unknown>;

  try {
    for (const name of ['localStorage', 'sessionStorage'] as const) {
      const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
      if (descriptor && !descriptor.configurable) {
        throw new MtprotoSpikeError(`MTProto spike cannot disable ${name}`);
      }
      snapshots.push({ name, descriptor });
      Object.defineProperty(globalObject, name, {
        configurable: true,
        enumerable: descriptor?.enumerable ?? false,
        value: undefined,
        writable: true,
      });
    }
  } catch (error) {
    for (const snapshot of snapshots.reverse()) {
      if (snapshot.descriptor) {
        Object.defineProperty(globalObject, snapshot.name, snapshot.descriptor);
      } else {
        delete globalObject[snapshot.name];
      }
    }
    throw error;
  }

  return () => {
    for (const snapshot of snapshots.reverse()) {
      if (snapshot.descriptor) {
        Object.defineProperty(globalObject, snapshot.name, snapshot.descriptor);
      } else {
        delete globalObject[snapshot.name];
      }
    }
  };
}

async function loadTelegramRuntime(): Promise<TelegramRuntime> {
  requireBrowserPrerequisites();
  let restoreStorage: (() => void) | undefined;

  try {
    restoreStorage = hideBrowserStorage();
    const runtime = await import('telegram');
    if (
      typeof runtime.TelegramClient !== 'function' ||
      typeof runtime.sessions?.StringSession !== 'function' ||
      typeof runtime.extensions?.PromisedWebSockets !== 'function' ||
      typeof runtime.Api?.Channel !== 'function' ||
      typeof runtime.Api?.User !== 'function' ||
      typeof runtime.Api?.DocumentAttributeFilename !== 'function'
    ) {
      throw new MtprotoSpikeError('MTProto browser runtime exports are incomplete');
    }
    return runtime;
  } catch (error) {
    if (error instanceof MtprotoSpikeError) throw error;
    throw new MtprotoSpikeError(`MTProto browser runtime unavailable: ${errorText(error)}`, {
      cause: error,
    });
  } finally {
    restoreStorage?.();
  }
}

function promptValue(label: string): Promise<string> {
  const value = window.prompt(label);
  if (!value?.trim()) {
    throw new MtprotoSpikeError(`${label} is required`);
  }
  return Promise.resolve(value.trim());
}

function toId(value: unknown): string {
  if (value === undefined || value === null) {
    throw new MtprotoSpikeError('Telegram response omitted required identifier');
  }
  return String(value);
}

function documentSize(document: Api.Document): number {
  const size = Number(document.size);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new MtprotoSpikeError('Telegram document size is unsupported');
  }
  return size;
}

function documentFileName(runtime: TelegramRuntime, document: Api.Document, fallback: string): string {
  const attribute = document.attributes.find(
    (item) => item instanceof runtime.Api.DocumentAttributeFilename,
  );
  return attribute?.fileName || fallback;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function downloadedBytes(value: string | Buffer | undefined): Uint8Array {
  if (value === undefined) {
    throw new MtprotoSpikeError('Telegram download returned no bytes');
  }
  if (typeof value === 'string') {
    throw new MtprotoSpikeError('Telegram browser download returned a path instead of bytes');
  }
  return new Uint8Array(value);
}

async function bestEffortLogout(client: TelegramClient, runtime: TelegramRuntime): Promise<boolean> {
  try {
    const LogOut = runtime.Api.auth?.LogOut;
    if (typeof LogOut !== 'function') return false;
    await client.invoke(new LogOut());
    return true;
  } catch {
    return false;
  }
}

export class MtprotoSpikeAdapter {
  private readonly options: MtprotoSpikeOptions;
  private readonly maxFileBytes: number;
  private readonly channels = new Map<string, ChannelSelection>();
  private runtime?: TelegramRuntime;
  private client?: TelegramClient;
  private selectedChannel?: ChannelSelection;

  constructor(options: MtprotoSpikeOptions) {
    if (!Number.isSafeInteger(options.apiId) || options.apiId <= 0) {
      throw new MtprotoSpikeError('Telegram api_id must be a positive integer');
    }
    if (typeof options.apiHash !== 'string' || !options.apiHash.trim()) {
      throw new MtprotoSpikeError('Telegram api_hash is required');
    }
    const maxFileBytes = options.maxFileBytes ?? MT_PROTO_SPIKE_MAX_FILE_BYTES;
    if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes <= 0) {
      throw new MtprotoSpikeError('MTProto spike file limit must be a positive integer');
    }
    this.options = options;
    this.maxFileBytes = Math.min(maxFileBytes, MT_PROTO_SPIKE_MAX_FILE_BYTES);
  }

  async authenticate(): Promise<MtprotoUser> {
    requireBrowserPrerequisites();
    if (this.client) {
      throw new MtprotoSpikeError('MTProto spike is already authenticated');
    }

    const runtime = await loadTelegramRuntime();
    const session = new runtime.sessions.StringSession('');
    // GramJS persists auth keys through this hook; spike must remain memory-only.
    Object.defineProperty(session, 'save', { value: () => '' });

    const client = new runtime.TelegramClient(session, this.options.apiId, this.options.apiHash, {
      useWSS: true,
      networkSocket: runtime.extensions.PromisedWebSockets,
      deviceModel: 'Teledrive MTProto spike',
      systemVersion: 'Browser',
      appVersion: 'Phase 2',
      requestRetries: 2,
      connectionRetries: 1,
      reconnectRetries: 1,
    });

    const prompts = this.options.prompts;
    const onError = (error: Error): never => {
      throw new MtprotoSpikeError(`Telegram authentication failed: ${errorText(error)}`, {
        cause: error,
      });
    };

    try {
      await client.start({
        phoneNumber: prompts?.phoneNumber ?? (() => promptValue('Telegram phone number')),
        phoneCode:
          prompts?.phoneCode ??
          (() => promptValue('Telegram login code')),
        password: prompts?.password ?? (() => promptValue('Telegram 2FA password')),
        onError,
      });
      const me = await client.getMe();
      if (!(me instanceof runtime.Api.User)) {
        throw new MtprotoSpikeError('Telegram authentication did not return a user');
      }
      this.runtime = runtime;
      this.client = client;
      return {
        id: toId(me.id),
        username: me.username,
        firstName: me.firstName,
        lastName: me.lastName,
      };
    } catch (error) {
      this.client = undefined;
      this.runtime = undefined;
      this.selectedChannel = undefined;
      this.channels.clear();
      await bestEffortLogout(client, runtime);
      try {
        await client.disconnect();
      } catch {
        // Preserve authentication error when transport cleanup fails.
      }
      if (error instanceof MtprotoSpikeError) throw error;
      throw new MtprotoSpikeError(`Telegram authentication failed: ${errorText(error)}`, {
        cause: error,
      });
    }
  }

  async getMe(): Promise<MtprotoUser> {
    const { client, runtime } = this.requireAuthenticated();
    const me = await client.getMe();
    if (!(me instanceof runtime.Api.User)) {
      throw new MtprotoSpikeError('Telegram getMe returned an unsupported user');
    }
    return {
      id: toId(me.id),
      username: me.username,
      firstName: me.firstName,
      lastName: me.lastName,
    };
  }

  async listVisibleChannels(): Promise<MtprotoChannel[]> {
    const { client, runtime } = this.requireAuthenticated();
    const channels: MtprotoChannel[] = [];
    this.channels.clear();
    this.selectedChannel = undefined;

    for await (const dialog of client.iterDialogs({ limit: 100 })) {
      if (!dialog.isChannel || !(dialog.entity instanceof runtime.Api.Channel)) continue;
      const channel = dialog.entity;
      if (channel.username || !channel.broadcast || channel.megagroup) continue;
      const visible: MtprotoChannel = {
        id: toId(channel.id),
        title: dialog.title ?? channel.title,
        username: channel.username,
        isPrivate: !channel.username,
        isBroadcast: !!channel.broadcast,
        isMegagroup: !!channel.megagroup,
      };
      this.channels.set(visible.id, { channel: visible, inputEntity: dialog.inputEntity });
      channels.push(visible);
    }

    return channels;
  }

  selectChannel(channelId: string): MtprotoChannel {
    const selection = this.channels.get(channelId);
    if (!selection) {
      throw new MtprotoSpikeError('Selected channel is not in visible Telegram dialogs');
    }
    this.selectedChannel = selection;
    return selection.channel;
  }

  async sendDocument(file: File): Promise<MtprotoDocumentReceipt> {
    const { client, runtime } = this.requireAuthenticated();
    const selection = this.selectedChannel;
    if (!selection) {
      throw new MtprotoSpikeError('Select visible Telegram channel before sending');
    }
    if (!(file instanceof File)) {
      throw new MtprotoSpikeError('MTProto spike accepts DOM File values only');
    }
    if (file.size <= 0 || file.size > this.maxFileBytes) {
      throw new MtprotoSpikeError(
        `MTProto spike accepts non-empty files up to ${this.maxFileBytes} bytes`,
      );
    }

    const sourceBytes = new Uint8Array(await file.arrayBuffer());
    const sha256 = await sha256Hex(sourceBytes);
    const [{ CustomFile }, { Buffer }] = await Promise.all([
      import('telegram/client/uploads'),
      import('buffer'),
    ]);
    const telegramFile = new CustomFile(file.name, file.size, '', Buffer.from(sourceBytes));
    const message = await client.sendFile(selection.inputEntity, {
      file: telegramFile,
      forceDocument: true,
      workers: 1,
      fileSize: file.size,
    });
    const document = message.document;
    if (!document) {
      throw new MtprotoSpikeError('Telegram send did not return a document message');
    }
    const size = documentSize(document);
    if (size !== file.size) {
      throw new MtprotoSpikeError('Telegram document size differs from selected File');
    }
    if (!Number.isSafeInteger(message.id)) {
      throw new MtprotoSpikeError('Telegram send returned an unsupported message ID');
    }

    return {
      channelId: selection.channel.id,
      messageId: message.id,
      documentId: toId(document.id),
      fileName: documentFileName(runtime, document, file.name),
      mimeType: document.mimeType,
      size,
      sha256,
    };
  }

  async refetchMessage(receipt: MtprotoDocumentReceipt): Promise<MtprotoMessageRef> {
    const message = await this.fetchDocumentMessage(receipt);
    return this.messageReference(receipt.channelId, message);
  }

  async downloadAndVerify(receipt: MtprotoDocumentReceipt): Promise<MtprotoDownloadVerification> {
    const message = await this.fetchDocumentMessage(receipt);
    const downloaded = downloadedBytes(await message.downloadMedia({}));
    if (downloaded.byteLength > this.maxFileBytes) {
      throw new MtprotoSpikeError('Telegram download exceeded MTProto spike file limit');
    }
    const downloadedSha256 = await sha256Hex(downloaded);
    if (downloadedSha256 !== receipt.sha256 || downloaded.byteLength !== receipt.size) {
      throw new MtprotoSpikeError('SHA-256 verification failed for refetched Telegram document');
    }
    return {
      receipt,
      downloadedSize: downloaded.byteLength,
      downloadedSha256,
      bytes: downloaded,
      verified: true,
    };
  }

  async disconnect(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.runtime = undefined;
    this.selectedChannel = undefined;
    this.channels.clear();
    await client?.disconnect();
  }

  async logout(): Promise<boolean> {
    const client = this.client;
    const runtime = this.runtime;
    if (!client || !runtime) return false;

    let loggedOut = false;
    try {
      loggedOut = await bestEffortLogout(client, runtime);
    } finally {
      await this.disconnect().catch(() => undefined);
    }
    return loggedOut;
  }

  private requireAuthenticated(): { client: TelegramClient; runtime: TelegramRuntime } {
    requireBrowserPrerequisites();
    if (!this.client || !this.runtime) {
      throw new MtprotoSpikeError('Authenticate MTProto spike before using Telegram');
    }
    return { client: this.client, runtime: this.runtime };
  }

  private async fetchDocumentMessage(receipt: MtprotoDocumentReceipt): Promise<Api.Message> {
    const { client } = this.requireAuthenticated();
    const selection = this.channels.get(receipt.channelId);
    if (!selection) {
      throw new MtprotoSpikeError('Receipt channel is not in visible Telegram dialogs');
    }
    const messages = await client.getMessages(selection.inputEntity, { ids: receipt.messageId });
    const message = messages[0];
    if (!message || message.id !== receipt.messageId || !message.document) {
      throw new MtprotoSpikeError('Telegram receipt message could not be refetched');
    }
    if (toId(message.document.id) !== receipt.documentId) {
      throw new MtprotoSpikeError('Refetched Telegram message document does not match receipt');
    }
    return message;
  }

  private messageReference(channelId: string, message: Api.Message): MtprotoMessageRef {
    const runtime = this.runtime;
    const document = message.document;
    if (!runtime || !document) {
      throw new MtprotoSpikeError('Telegram refetch returned no document');
    }
    const size = documentSize(document);
    return {
      channelId,
      messageId: message.id,
      documentId: toId(document.id),
      fileName: documentFileName(runtime, document, 'unnamed'),
      mimeType: document.mimeType,
      size,
    };
  }
}

export function createMtprotoSpikeAdapter(options: MtprotoSpikeOptions): MtprotoSpikeAdapter {
  return new MtprotoSpikeAdapter(options);
}

let sharedAdapter: MtprotoSpikeAdapter | undefined;

/** Minimal module-level seam for isolated client-only spike UI. */
export function connect(options: MtprotoSpikeOptions): MtprotoSpikeAdapter {
  if (sharedAdapter) throw new MtprotoSpikeError('MTProto spike is already connected');
  sharedAdapter = createMtprotoSpikeAdapter(options);
  return sharedAdapter;
}

function requireSharedAdapter(): MtprotoSpikeAdapter {
  if (!sharedAdapter) throw new MtprotoSpikeError('Connect MTProto spike before using it');
  return sharedAdapter;
}

async function resetSharedAdapter(): Promise<void> {
  const adapter = sharedAdapter;
  sharedAdapter = undefined;
  try {
    await adapter?.logout();
  } catch {
    // Preserve operation error when logout or transport cleanup fails.
  }
}

export async function login(): Promise<MtprotoUser> {
  try {
    return await requireSharedAdapter().authenticate();
  } catch (error) {
    await resetSharedAdapter();
    throw error;
  }
}

export async function listPrivateDialogs(): Promise<MtprotoChannel[]> {
  try {
    return await requireSharedAdapter().listVisibleChannels();
  } catch (error) {
    await resetSharedAdapter();
    throw error;
  }
}

export async function uploadFile(input: { dialogId: string | number; file: File }): Promise<MtprotoDocumentReceipt> {
  try {
    const adapter = requireSharedAdapter();
    adapter.selectChannel(String(input.dialogId));
    return await adapter.sendDocument(input.file);
  } catch (error) {
    await resetSharedAdapter();
    throw error;
  }
}

export async function refetchFile(receipt: MtprotoDocumentReceipt): Promise<MtprotoDocumentReceipt> {
  try {
    const adapter = requireSharedAdapter();
    return { ...receipt, ...(await adapter.refetchMessage(receipt)) };
  } catch (error) {
    await resetSharedAdapter();
    throw error;
  }
}

export async function downloadFile(receipt: MtprotoDocumentReceipt): Promise<Uint8Array> {
  try {
    return (await requireSharedAdapter().downloadAndVerify(receipt)).bytes;
  } catch (error) {
    await resetSharedAdapter();
    throw error;
  }
}

export async function disconnect(): Promise<void> {
  const adapter = sharedAdapter;
  sharedAdapter = undefined;
  await adapter?.disconnect();
}

export async function logout(): Promise<boolean> {
  const adapter = sharedAdapter;
  sharedAdapter = undefined;
  return adapter ? adapter.logout() : false;
}
