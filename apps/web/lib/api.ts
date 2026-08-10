import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/browser';

export type ApiUser = { id: string; username: string; displayName: string };
export type Folder = { id: string; name: string; parentId: string | null };
export type Workspace = { id: string; name: string };
export type WorkspaceResponse = { workspace: Workspace; rootFolder: Pick<Folder, 'id' | 'name'> };

export type FolderItem = {
  kind: 'folder' | 'object';
  id: string;
  name: string;
  mime: string | null;
  size: number | null;
  status: string | null;
  createdAt: string;
};
export type FolderChildrenResponse = {
  folder: Pick<Folder, 'id' | 'name'>;
  items: FolderItem[];
  nextCursor: string | null;
};

export type ObjectListItem = {
  id: string;
  name: string;
  mime: string;
  size: number;
  status: string;
  createdAt: string;
  updatedAt?: string;
  deletedAt?: string | null;
};
export type PaginatedObjectResponse = { items: ObjectListItem[]; nextCursor: string | null };
export type ObjectUpdateInput = { name?: string; folderId?: string | null };
export type ObjectUpdateResponse = { id: string; name: string; folderId: string };
export type FolderUpdateInput = { name?: string; parentId?: string | null };
export type FolderUpdateResponse = { id: string; name: string; parentId: string | null };
export type MutationResponse = { ok: true; deleted?: boolean; restored?: boolean };

export type BotCompleteUploadInput = { partCount: number; size: number; sha256: string };
export type BotAbortUploadResponse = { ok: true; status: string };

export type ExportFolder = {
  id: string;
  parent_id: string | null;
  name: string;
  normalized_name: string;
  path_key: string;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
};
export type ExportObject = {
  id: string;
  folder_id: string;
  name: string;
  normalized_name: string;
  mime: string;
  size: number;
  sha256: string | null;
  part_count: number;
  status: string;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
};
export type ExportPart = {
  id: string;
  object_id: string;
  part_no: number;
  size: number;
  sha256: string;
  idempotency_key: string;
  created_at: string;
};
export type ExportResponse = {
  exportedAt: string;
  workspace: Workspace;
  folders: ExportFolder[];
  objects: ExportObject[];
  parts: ExportPart[];
};

export type PasskeyRegisterOptionsResponse = {
  challengeId: string;
  options: PublicKeyCredentialCreationOptionsJSON;
};
export type PasskeyAuthenticateOptionsResponse = {
  challengeId: string;
  options: PublicKeyCredentialRequestOptionsJSON;
};
export type AuthResponse = { user: ApiUser; csrfToken: string };
export type CurrentSessionResponse = { user: ApiUser | null };
export type GoogleAuthorizationMode = 'login' | 'link';

export type StoragePoolReasonCode =
  | 'READY'
  | 'CHANNEL_MISSING'
  | 'NO_VALID_BOTS'
  | 'GET_CHAT_HTTP_FAILURE'
  | 'GET_CHAT_TRANSPORT_FAILURE'
  | 'GET_CHAT_API_REJECTION'
  | 'INVALID_TELEGRAM_PAYLOAD';
export type StoragePoolReason = { code: StoragePoolReasonCode; message: string };
export type StoragePoolResponse = {
  channel: string;
  botCount: number;
  ready: boolean;
  /** Optional for compatibility with older Workers. */
  reason?: StoragePoolReason;
};

export type BotUploadStartInput = {
  name: string;
  size: number;
  mime: string;
  folderId?: string | null;
  chunkSize: number;
  partCount: number;
  sha256: string;
  idempotencyKey: string;
};
export type BotUploadSession = {
  id: string;
  objectId: string;
  status: string;
  chunkSize: number;
  expectedPartCount: number;
  expiresAt: string;
};
export type BotPart = { partNo: number; size: number; sha256: string };
export type BotPartUploadInput = { size: number; sha256: string; idempotencyKey: string };
export type BotAttemptStatus = {
  partNo: number;
  status: 'not_started' | 'in_progress' | 'ambiguous' | 'committed' | 'abandoned';
  createdAt?: string;
  updatedAt?: string;
};
export type BotObject = {
  id: string;
  folderId: string;
  name: string;
  mime: string;
  size: number;
  sha256: string | null;
  partCount: number;
  status: string;
  createdAt: string;
  updatedAt: string;
};
export type BotManifestResponse = { object: BotObject; parts: BotPart[] };
export type BotCompleteUploadResponse = { objectId: string; status: string; idempotent: boolean };

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly requestId?: string,
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = 'ApiError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type JsonRecord = Record<string, unknown>;

export interface ApiClient {
  getCsrf(): Promise<string>;
  registerPasskeyOptions(
    userName: string,
    displayName?: string,
    bootstrapToken?: string,
  ): Promise<PasskeyRegisterOptionsResponse>;
  registerPasskeyVerify(
    challengeId: string,
    response: RegistrationResponseJSON,
    bootstrapToken?: string,
  ): Promise<AuthResponse>;
  authenticatePasskeyOptions(userName: string): Promise<PasskeyAuthenticateOptionsResponse>;
  authenticatePasskeyVerify(challengeId: string, response: AuthenticationResponseJSON): Promise<AuthResponse>;
  googleAuthorizationUrl(mode: GoogleAuthorizationMode): Promise<string>;
  getCurrentSession(): Promise<ApiUser | null>;
  logout(): Promise<{ ok: true }>;
  getStoragePool(): Promise<StoragePoolResponse>;
  getWorkspace(): Promise<WorkspaceResponse>;
  listFolderChildren(folderId: string, options?: { limit?: number; cursor?: string }): Promise<FolderChildrenResponse>;
  listRecent(options?: { limit?: number; cursor?: string }): Promise<PaginatedObjectResponse>;
  listTrash(options?: { limit?: number; cursor?: string }): Promise<PaginatedObjectResponse>;
  createFolder(name: string, parentId: string | null): Promise<Folder>;
  updateFolder(folderId: string, input: FolderUpdateInput): Promise<FolderUpdateResponse>;
  updateObject(objectId: string, input: ObjectUpdateInput): Promise<ObjectUpdateResponse>;
  softDeleteObject(objectId: string): Promise<MutationResponse>;
  restoreObject(objectId: string): Promise<MutationResponse>;
  permanentDeleteObject(objectId: string): Promise<MutationResponse>;
  softDeleteFolder(folderId: string): Promise<MutationResponse>;
  restoreFolder(folderId: string): Promise<MutationResponse>;
  permanentDeleteFolder(folderId: string): Promise<MutationResponse>;
  startBotUpload(input: BotUploadStartInput): Promise<BotUploadSession>;
  uploadBotPart(uploadId: string, partNo: number, body: BodyInit, input: BotPartUploadInput): Promise<BotPart>;
  getBotUpload(uploadId: string): Promise<BotUploadSession>;
  getBotPartAttempt(uploadId: string, partNo: number): Promise<BotAttemptStatus>;
  abandonBotPartAttempt(uploadId: string, partNo: number): Promise<BotAttemptStatus & { consequence?: string }>;
  completeBotUpload(uploadId: string, metadata: BotCompleteUploadInput): Promise<BotCompleteUploadResponse>;
  abortBotUpload(uploadId: string): Promise<BotAbortUploadResponse>;
  getBotManifest(objectId: string): Promise<BotManifestResponse>;
  getBotPartContent(objectId: string, partNo: number): Promise<Response>;
  getBotPartBytes(objectId: string, partNo: number): Promise<Uint8Array>;
  exportWorkspace(): Promise<ExportResponse>;
}

type ApiClientOptions = { baseUrl?: string; fetch?: FetchLike };

function record(value: unknown): JsonRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 2048 ? value : undefined;
}

function safeApiError(response: Response, body: unknown): ApiError {
  const root = record(body);
  const error = record(root?.error);
  const code = stringField(error?.code) ?? `HTTP_${response.status}`;
  const message = stringField(error?.message) ?? `API request failed (${response.status})`;
  const requestId = stringField(error?.requestId) ?? stringField(response.headers.get('X-Request-ID'));
  const retryHeader = response.headers.get('Retry-After');
  const retryAfter = retryHeader && /^\d+$/u.test(retryHeader) ? Number(retryHeader) : undefined;
  return new ApiError(
    code,
    message,
    response.status,
    requestId,
    retryAfter !== undefined && Number.isSafeInteger(retryAfter) ? retryAfter : undefined,
  );
}

function safeStoragePoolReason(value: unknown): StoragePoolReason {
  const root = record(value);
  const codes = new Set<StoragePoolReasonCode>([
    'READY',
    'CHANNEL_MISSING',
    'NO_VALID_BOTS',
    'GET_CHAT_HTTP_FAILURE',
    'GET_CHAT_TRANSPORT_FAILURE',
    'GET_CHAT_API_REJECTION',
    'INVALID_TELEGRAM_PAYLOAD',
  ]);
  if (
    !root ||
    typeof root.code !== 'string' ||
    !codes.has(root.code as StoragePoolReasonCode) ||
    typeof root.message !== 'string' ||
    root.message.length === 0 ||
    root.message.length > 2048
  )
    throw new ApiError('INVALID_RESPONSE', 'Storage pool reason is invalid', 500);
  return { code: root.code as StoragePoolReasonCode, message: root.message as string };
}

function safeBotSession(value: unknown): BotUploadSession {
  const root = record(value);
  if (
    !root ||
    typeof root.id !== 'string' ||
    typeof root.objectId !== 'string' ||
    typeof root.status !== 'string' ||
    !Number.isSafeInteger(root.chunkSize) ||
    !Number.isSafeInteger(root.expectedPartCount) ||
    typeof root.expiresAt !== 'string'
  ) {
    throw new ApiError('INVALID_RESPONSE', 'Bot upload response is invalid', 500);
  }
  return {
    id: root.id,
    objectId: root.objectId,
    status: root.status,
    chunkSize: root.chunkSize as number,
    expectedPartCount: root.expectedPartCount as number,
    expiresAt: root.expiresAt,
  };
}

function safeBotPart(value: unknown): BotPart {
  const root = record(value);
  if (
    !root ||
    !Number.isSafeInteger(root.partNo) ||
    !Number.isSafeInteger(root.size) ||
    typeof root.sha256 !== 'string'
  )
    throw new ApiError('INVALID_RESPONSE', 'Bot part response is invalid', 500);
  return { partNo: root.partNo as number, size: root.size as number, sha256: root.sha256 };
}

function safeBotAttempt(value: unknown): BotAttemptStatus & { consequence?: string } {
  const root = record(value);
  const statuses = new Set(['not_started', 'in_progress', 'ambiguous', 'committed', 'abandoned']);
  if (!root || !Number.isSafeInteger(root.partNo) || typeof root.status !== 'string' || !statuses.has(root.status))
    throw new ApiError('INVALID_RESPONSE', 'Bot attempt response is invalid', 500);
  return {
    partNo: root.partNo as number,
    status: root.status as BotAttemptStatus['status'],
    ...(typeof root.createdAt === 'string' ? { createdAt: root.createdAt } : {}),
    ...(typeof root.updatedAt === 'string' ? { updatedAt: root.updatedAt } : {}),
    ...(typeof root.consequence === 'string' ? { consequence: root.consequence } : {}),
  };
}

function safeBotObject(value: unknown): BotObject {
  const root = record(value);
  if (
    !root ||
    typeof root.id !== 'string' ||
    typeof root.folderId !== 'string' ||
    typeof root.name !== 'string' ||
    typeof root.mime !== 'string' ||
    !Number.isSafeInteger(root.size) ||
    (root.sha256 !== null && typeof root.sha256 !== 'string') ||
    !Number.isSafeInteger(root.partCount) ||
    typeof root.status !== 'string' ||
    typeof root.createdAt !== 'string' ||
    typeof root.updatedAt !== 'string'
  ) {
    throw new ApiError('INVALID_RESPONSE', 'Bot object response is invalid', 500);
  }
  return {
    id: root.id,
    folderId: root.folderId,
    name: root.name,
    mime: root.mime,
    size: root.size as number,
    sha256: root.sha256,
    partCount: root.partCount as number,
    status: root.status,
    createdAt: root.createdAt,
    updatedAt: root.updatedAt,
  };
}

function safeBotManifest(value: unknown): BotManifestResponse {
  const root = record(value);
  if (!root || !Array.isArray(root.parts))
    throw new ApiError('INVALID_RESPONSE', 'Bot manifest response is invalid', 500);
  return { object: safeBotObject(root.object), parts: root.parts.map(safeBotPart) };
}

function safeExport(value: unknown): ExportResponse {
  const root = record(value);
  const workspace = record(root?.workspace);
  if (
    !root ||
    typeof root.exportedAt !== 'string' ||
    !workspace ||
    typeof workspace.id !== 'string' ||
    typeof workspace.name !== 'string'
  )
    throw new ApiError('INVALID_RESPONSE', 'Export response is invalid', 500);
  const folders = Array.isArray(root.folders) ? root.folders : [];
  const objects = Array.isArray(root.objects) ? root.objects : [];
  const parts = Array.isArray(root.parts) ? root.parts : [];
  return {
    exportedAt: root.exportedAt,
    workspace: { id: workspace.id, name: workspace.name },
    folders: folders as ExportFolder[],
    objects: objects as ExportObject[],
    parts: parts.map((part) => {
      const item = record(part);
      if (
        !item ||
        typeof item.id !== 'string' ||
        typeof item.object_id !== 'string' ||
        !Number.isSafeInteger(item.part_no) ||
        !Number.isSafeInteger(item.size) ||
        typeof item.sha256 !== 'string' ||
        typeof item.idempotency_key !== 'string' ||
        typeof item.created_at !== 'string'
      )
        throw new ApiError('INVALID_RESPONSE', 'Export response is invalid', 500);
      return {
        id: item.id,
        object_id: item.object_id,
        part_no: item.part_no as number,
        size: item.size as number,
        sha256: item.sha256,
        idempotency_key: item.idempotency_key,
        created_at: item.created_at,
      };
    }),
  };
}

export class MetadataApiClient implements ApiClient {
  private csrfToken: string | undefined;
  private csrfRequest: Promise<string> | undefined;
  private readonly baseUrl: string;
  private readonly fetcher: FetchLike;

  constructor(options: ApiClientOptions = {}) {
    const baseUrl = options.baseUrl ?? process.env.NEXT_PUBLIC_API_URL;
    this.baseUrl = (baseUrl ?? '').replace(/\/+$/u, '');
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private async requestResponse(
    path: string,
    init: RequestInit = {},
    csrf = false,
    retryCsrf = true,
  ): Promise<Response> {
    if (!this.baseUrl) throw new ApiError('API_CONFIGURATION_ERROR', 'NEXT_PUBLIC_API_URL is required', 500);
    const headers = new Headers(init.headers);
    if (init.body !== undefined && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    if (csrf) headers.set('X-CSRF-Token', await this.getCsrf());

    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}${path}`, { ...init, headers, credentials: 'include' });
    } catch {
      throw new ApiError('NETWORK_ERROR', 'API request could not be sent', 0);
    }

    if (!response.ok) {
      const body = await response.json().catch(() => undefined);
      const error = safeApiError(response, body);
      if (
        csrf &&
        retryCsrf &&
        response.status === 403 &&
        (error.code === 'CSRF_INVALID' || error.code === 'CSRF_REQUIRED')
      ) {
        this.csrfToken = undefined;
        await this.getCsrf();
        return this.requestResponse(path, init, true, false);
      }
      throw error;
    }
    return response;
  }

  private async request<T>(path: string, init: RequestInit = {}, csrf = false): Promise<T> {
    const response = await this.requestResponse(path, init, csrf);
    const body = await response.json().catch(() => undefined);
    if (body === undefined) throw new ApiError('INVALID_RESPONSE', 'API returned invalid JSON', response.status);
    return body as T;
  }

  async getCsrf(): Promise<string> {
    if (this.csrfToken) return this.csrfToken;
    if (this.csrfRequest) return this.csrfRequest;
    this.csrfRequest = this.request<{ csrfToken: string }>('/v1/auth/csrf')
      .then((result) => {
        if (!result || typeof result.csrfToken !== 'string' || result.csrfToken.length === 0) {
          throw new ApiError('INVALID_RESPONSE', 'CSRF response is invalid', 500);
        }
        this.csrfToken = result.csrfToken;
        return result.csrfToken;
      })
      .finally(() => {
        this.csrfRequest = undefined;
      });
    return this.csrfRequest;
  }

  async registerPasskeyOptions(userName: string, displayName?: string, bootstrapToken?: string) {
    const headers = bootstrapToken ? { 'X-Bootstrap-Token': bootstrapToken } : undefined;
    return this.request<PasskeyRegisterOptionsResponse>(
      '/v1/auth/passkey/register/options',
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ userName, ...(displayName === undefined ? {} : { displayName }) }),
      },
      true,
    );
  }

  async registerPasskeyVerify(challengeId: string, response: RegistrationResponseJSON, bootstrapToken?: string) {
    const headers = bootstrapToken ? { 'X-Bootstrap-Token': bootstrapToken } : undefined;
    const result = await this.request<AuthResponse>(
      '/v1/auth/passkey/register/verify',
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ challengeId, response }),
      },
      true,
    );
    this.csrfToken = result.csrfToken;
    return result;
  }

  authenticatePasskeyOptions(userName: string) {
    return this.request<PasskeyAuthenticateOptionsResponse>(
      '/v1/auth/passkey/authenticate/options',
      {
        method: 'POST',
        body: JSON.stringify({ userName }),
      },
      true,
    );
  }

  async authenticatePasskeyVerify(challengeId: string, response: AuthenticationResponseJSON) {
    const result = await this.request<AuthResponse>(
      '/v1/auth/passkey/authenticate/verify',
      {
        method: 'POST',
        body: JSON.stringify({ challengeId, response }),
      },
      true,
    );
    this.csrfToken = result.csrfToken;
    return result;
  }

  async googleAuthorizationUrl(mode: GoogleAuthorizationMode): Promise<string> {
    const result = await this.request<{ authorizationUrl: unknown }>(
      '/v1/auth/google/start',
      { method: 'POST', body: JSON.stringify({ mode }) },
      true,
    );
    if (typeof result.authorizationUrl !== 'string' || result.authorizationUrl.length === 0)
      throw new ApiError('INVALID_RESPONSE', 'Google authorization response is invalid', 500);
    return result.authorizationUrl;
  }

  async getCurrentSession(): Promise<ApiUser | null> {
    const result = await this.request<CurrentSessionResponse>('/v1/auth/session');
    return result.user;
  }

  async logout() {
    const result = await this.request<{ ok: true }>('/v1/auth/logout', { method: 'POST', body: '{}' }, true);
    this.csrfToken = undefined;
    return result;
  }

  async getStoragePool(): Promise<StoragePoolResponse> {
    const result = await this.request<unknown>('/v1/telegram/pool');
    const root = record(result);
    const channel = stringField(root?.channel);
    if (
      !root ||
      channel === undefined ||
      !Number.isSafeInteger(root.botCount) ||
      (root.botCount as number) < 0 ||
      typeof root.ready !== 'boolean'
    )
      throw new ApiError('INVALID_RESPONSE', 'Storage pool response is invalid', 500);
    return {
      channel,
      botCount: root.botCount as number,
      ready: root.ready,
      ...(root.reason === undefined ? {} : { reason: safeStoragePoolReason(root.reason) }),
    };
  }

  getWorkspace() {
    return this.request<WorkspaceResponse>('/v1/workspace');
  }

  listFolderChildren(folderId: string, options: { limit?: number; cursor?: string } = {}) {
    return this.request<FolderChildrenResponse>(
      `/v1/folders/${encodeURIComponent(folderId)}/children${this.pageQuery(options)}`,
    );
  }

  listRecent(options: { limit?: number; cursor?: string } = {}) {
    return this.request<PaginatedObjectResponse>(`/v1/objects/recent${this.pageQuery(options)}`);
  }

  listTrash(options: { limit?: number; cursor?: string } = {}) {
    return this.request<PaginatedObjectResponse>(`/v1/trash${this.pageQuery(options)}`);
  }

  private pageQuery(options: { limit?: number; cursor?: string }): string {
    const query = new URLSearchParams();
    if (options.limit !== undefined) query.set('limit', String(options.limit));
    if (options.cursor !== undefined) query.set('cursor', options.cursor);
    const value = query.toString();
    return value ? `?${value}` : '';
  }

  createFolder(name: string, parentId: string | null) {
    return this.request<Folder>(
      '/v1/folders',
      {
        method: 'POST',
        body: JSON.stringify({ name, parentId }),
      },
      true,
    );
  }

  updateObject(objectId: string, input: ObjectUpdateInput) {
    return this.request<ObjectUpdateResponse>(
      `/v1/objects/${encodeURIComponent(objectId)}`,
      {
        method: 'PATCH',
        body: JSON.stringify(input),
      },
      true,
    );
  }

  updateFolder(folderId: string, input: FolderUpdateInput) {
    return this.request<FolderUpdateResponse>(
      `/v1/folders/${encodeURIComponent(folderId)}`,
      {
        method: 'PATCH',
        body: JSON.stringify(input),
      },
      true,
    );
  }

  softDeleteObject(objectId: string) {
    return this.request<MutationResponse>(`/v1/objects/${encodeURIComponent(objectId)}`, { method: 'DELETE' }, true);
  }

  restoreObject(objectId: string) {
    return this.request<MutationResponse>(
      `/v1/objects/${encodeURIComponent(objectId)}/restore`,
      { method: 'POST', body: '{}' },
      true,
    );
  }

  permanentDeleteObject(objectId: string) {
    return this.request<MutationResponse>(
      `/v1/objects/${encodeURIComponent(objectId)}/permanent`,
      { method: 'DELETE' },
      true,
    );
  }

  softDeleteFolder(folderId: string) {
    return this.request<MutationResponse>(`/v1/folders/${encodeURIComponent(folderId)}`, { method: 'DELETE' }, true);
  }

  restoreFolder(folderId: string) {
    return this.request<MutationResponse>(
      `/v1/folders/${encodeURIComponent(folderId)}/restore`,
      { method: 'POST', body: '{}' },
      true,
    );
  }

  permanentDeleteFolder(folderId: string) {
    return this.request<MutationResponse>(
      `/v1/folders/${encodeURIComponent(folderId)}/permanent`,
      { method: 'DELETE' },
      true,
    );
  }

  startBotUpload(input: BotUploadStartInput): Promise<BotUploadSession> {
    return this.request<unknown>('/v1/bot/uploads', { method: 'POST', body: JSON.stringify(input) }, true).then(
      safeBotSession,
    );
  }

  uploadBotPart(uploadId: string, partNo: number, body: BodyInit, input: BotPartUploadInput): Promise<BotPart> {
    if (!input.idempotencyKey || !input.sha256 || !Number.isSafeInteger(input.size))
      return Promise.reject(
        new ApiError('UPLOAD_METADATA_REQUIRED', 'Part requires size, SHA-256, and idempotencyKey', 422),
      );
    return this.request<unknown>(
      `/v1/bot/uploads/${encodeURIComponent(uploadId)}/parts/${partNo}`,
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Part-Size': String(input.size),
          'X-Part-SHA256': input.sha256,
          'X-Idempotency-Key': input.idempotencyKey,
        },
        body,
      },
      true,
    ).then(safeBotPart);
  }

  getBotUpload(uploadId: string): Promise<BotUploadSession> {
    return this.request<unknown>(`/v1/bot/uploads/${encodeURIComponent(uploadId)}`).then(safeBotSession);
  }

  getBotPartAttempt(uploadId: string, partNo: number): Promise<BotAttemptStatus> {
    return this.request<unknown>(`/v1/bot/uploads/${encodeURIComponent(uploadId)}/parts/${partNo}/attempt`).then(
      safeBotAttempt,
    );
  }

  abandonBotPartAttempt(uploadId: string, partNo: number): Promise<BotAttemptStatus & { consequence?: string }> {
    return this.request<unknown>(
      `/v1/bot/uploads/${encodeURIComponent(uploadId)}/parts/${partNo}/attempt/abandon`,
      { method: 'POST', body: '{}' },
      true,
    ).then(safeBotAttempt);
  }

  completeBotUpload(uploadId: string, metadata: BotCompleteUploadInput): Promise<BotCompleteUploadResponse> {
    return this.request<BotCompleteUploadResponse>(
      `/v1/uploads/${encodeURIComponent(uploadId)}/complete`,
      { method: 'POST', body: JSON.stringify(metadata) },
      true,
    );
  }

  abortBotUpload(uploadId: string): Promise<BotAbortUploadResponse> {
    return this.request<BotAbortUploadResponse>(
      `/v1/uploads/${encodeURIComponent(uploadId)}`,
      { method: 'DELETE' },
      true,
    );
  }

  getBotManifest(objectId: string): Promise<BotManifestResponse> {
    return this.request<unknown>(`/v1/bot/objects/${encodeURIComponent(objectId)}/manifest`).then(safeBotManifest);
  }

  getBotPartContent(objectId: string, partNo: number): Promise<Response> {
    return this.requestResponse(`/v1/bot/objects/${encodeURIComponent(objectId)}/parts/${partNo}/content`);
  }

  async getBotPartBytes(objectId: string, partNo: number): Promise<Uint8Array> {
    return new Uint8Array(await (await this.getBotPartContent(objectId, partNo)).arrayBuffer());
  }

  exportWorkspace() {
    return this.request<unknown>('/v1/export').then(safeExport);
  }
}

export const api: ApiClient = new MetadataApiClient();
export const API_FEATURES = { serverMetadata: true, share: false, auth: true } as const;
