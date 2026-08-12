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
  type?: 'object' | 'folder';
  id: string;
  name: string;
  mime: string | null;
  size: number | null;
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

/** Kept for current UI callers; upload-controller supplies complete metadata. */
export type UploadMetadata = {
  name: string;
  size: number;
  mime: string;
  folderId: string;
  lastModified: number;
  partCount: number;
};

export type UploadStartInput = {
  name: string;
  size: number;
  mime: string;
  folderId?: string | null;
  chunkSize: number;
  partCount: number;
  sha256: string;
  idempotencyKey: string;
};

export type UploadSession = {
  id: string;
  objectId: string;
  status: string;
  chunkSize: number;
  expectedPartCount: number;
  expiresAt: string;
};

export type UploadPartInput = {
  partNo: number;
  size: number;
  sha256: string;
  messageId: string;
  botFileId?: string | null;
  idempotencyKey: string;
};

export type UploadPart = UploadPartInput & {
  id: string;
  objectId: string;
  botFileId: string | null;
  createdAt: string;
};

export type UploadResponse = UploadSession & {
  object: {
    id: string;
    name: string;
    mime: string;
    size: number;
    sha256: string | null;
    status: string;
  };
  parts: UploadPart[];
};

export type CompleteUploadInput = { partCount: number; size: number; sha256: string };
export type CompleteUploadResponse = { objectId: string; status: string; idempotent: boolean };
export type AbortUploadResponse = { ok: true; status: string };

export type ManifestResponse = {
  object: {
    id: string;
    folderId: string;
    name: string;
    mime: string;
    size: number;
    sha256: string | null;
    partCount: number;
    status: string;
    deletedAt: string | null;
    createdAt: string;
    updatedAt: string;
  };
  parts: UploadPart[];
};

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
  message_id: string;
  bot_file_id: string | null;
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

export type AuthResponse = { user: ApiUser; csrfToken: string };
export type CurrentSessionResponse = { user: ApiUser | null };

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly requestId?: string,
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
  authenticateTelegram(params: { telegramId: number | string; displayName?: string; username?: string; phone?: string }): Promise<AuthResponse>;
  getCurrentSession(): Promise<ApiUser | null>;
  logout(): Promise<{ ok: true }>;
  getWorkspace(): Promise<WorkspaceResponse>;
  listFolderChildren(folderId: string, options?: { limit?: number; cursor?: string }): Promise<FolderChildrenResponse>;
  listRecent(options?: { limit?: number; cursor?: string }): Promise<PaginatedObjectResponse>;
  listTrash(options?: { limit?: number; cursor?: string }): Promise<PaginatedObjectResponse>;
  purgeTrash(): Promise<{ ok: true; objects: number; folders: number }>;
  createFolder(name: string, parentId: string | null): Promise<Folder>;
  updateFolder(folderId: string, input: FolderUpdateInput): Promise<FolderUpdateResponse>;
  updateObject(objectId: string, input: ObjectUpdateInput): Promise<ObjectUpdateResponse>;
  softDeleteObject(objectId: string): Promise<MutationResponse>;
  restoreObject(objectId: string): Promise<MutationResponse>;
  permanentDeleteObject(objectId: string): Promise<MutationResponse>;
  softDeleteFolder(folderId: string): Promise<MutationResponse>;
  restoreFolder(folderId: string): Promise<MutationResponse>;
  permanentDeleteFolder(folderId: string): Promise<MutationResponse>;
  startUpload(metadata: UploadStartInput | UploadMetadata): Promise<UploadSession>;
  getUpload(uploadId: string): Promise<UploadResponse>;
  commitPart(uploadId: string, part: UploadPartInput | Omit<UploadPartInput, 'idempotencyKey'>): Promise<UploadPart>;
  completeUpload(uploadId: string, metadata?: CompleteUploadInput): Promise<CompleteUploadResponse>;
  abortUpload(uploadId: string): Promise<AbortUploadResponse>;
  getManifest(objectId: string): Promise<ManifestResponse>;
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
  return new ApiError(code, message, response.status, requestId);
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

  private async request<T>(path: string, init: RequestInit = {}, csrf = false, retryCsrf = true): Promise<T> {
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

    const body = await response.json().catch(() => undefined);
    if (!response.ok) {
      const error = safeApiError(response, body);
      if (
        csrf &&
        retryCsrf &&
        response.status === 403 &&
        (error.code === 'CSRF_INVALID' || error.code === 'CSRF_REQUIRED')
      ) {
        this.csrfToken = undefined;
        await this.getCsrf();
        return this.request<T>(path, init, true, false);
      }
      throw error;
    }
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

  async authenticateTelegram(params: { telegramId: number | string; displayName?: string; username?: string; phone?: string }) {
    const result = await this.request<AuthResponse>(
      '/v1/auth/telegram',
      {
        method: 'POST',
        body: JSON.stringify(params),
      },
      true,
    );
    this.csrfToken = result.csrfToken;
    return result;
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

  purgeTrash() {
    return this.request<{ ok: true; objects: number; folders: number }>('/v1/trash/purge-all', { method: 'DELETE' }, true);
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

  startUpload(metadata: UploadStartInput | UploadMetadata) {
    if (
      !('sha256' in metadata) ||
      !metadata.sha256 ||
      !('chunkSize' in metadata) ||
      !metadata.chunkSize ||
      !('idempotencyKey' in metadata) ||
      !metadata.idempotencyKey
    ) {
      return Promise.reject(
        new ApiError('UPLOAD_METADATA_REQUIRED', 'Upload requires chunkSize, SHA-256, and idempotencyKey', 422),
      );
    }
    const body: UploadStartInput = {
      name: metadata.name,
      size: metadata.size,
      mime: metadata.mime,
      folderId: 'folderId' in metadata ? metadata.folderId : undefined,
      chunkSize: metadata.chunkSize,
      partCount: metadata.partCount,
      sha256: metadata.sha256,
      idempotencyKey: metadata.idempotencyKey,
    };
    return this.request<UploadSession>('/v1/uploads', { method: 'POST', body: JSON.stringify(body) }, true);
  }

  getUpload(uploadId: string) {
    return this.request<UploadResponse>(`/v1/uploads/${encodeURIComponent(uploadId)}`);
  }

  commitPart(uploadId: string, part: UploadPartInput | Omit<UploadPartInput, 'idempotencyKey'>) {
    if (!('idempotencyKey' in part) || !part.idempotencyKey) {
      return Promise.reject(new ApiError('UPLOAD_METADATA_REQUIRED', 'Part requires idempotencyKey', 422));
    }
    const body: UploadPartInput = {
      partNo: part.partNo,
      size: part.size,
      sha256: part.sha256,
      messageId: part.messageId,
      botFileId: part.botFileId,
      idempotencyKey: part.idempotencyKey,
    };
    return this.request<UploadPart>(
      `/v1/uploads/${encodeURIComponent(uploadId)}/parts/${part.partNo}`,
      {
        method: 'PUT',
        body: JSON.stringify(body),
      },
      true,
    );
  }

  completeUpload(uploadId: string, metadata?: CompleteUploadInput) {
    if (!metadata)
      return Promise.reject(
        new ApiError('UPLOAD_METADATA_REQUIRED', 'Complete requires partCount, size, and SHA-256', 422),
      );
    return this.request<CompleteUploadResponse>(
      `/v1/uploads/${encodeURIComponent(uploadId)}/complete`,
      {
        method: 'POST',
        body: JSON.stringify(metadata),
      },
      true,
    );
  }

  abortUpload(uploadId: string) {
    return this.request<AbortUploadResponse>(`/v1/uploads/${encodeURIComponent(uploadId)}`, { method: 'DELETE' }, true);
  }

  getManifest(objectId: string) {
    return this.request<ManifestResponse>(`/v1/objects/${encodeURIComponent(objectId)}/manifest`);
  }

  exportWorkspace() {
    return this.request<ExportResponse>('/v1/export');
  }
}

export const api: ApiClient = new MetadataApiClient();
export const API_FEATURES = { serverMetadata: true, share: false, auth: true } as const;
