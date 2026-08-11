export const MIN_CHUNK_SIZE = 8 * 1024 * 1024;
export const CHUNK_SIZE = 16 * 1024 * 1024;
export const MAX_CHUNK_SIZE = 19 * 1024 * 1024;
export const MTPROTO_PART_SIZE = 512 * 1024;
export const MAX_CONCURRENCY = 4;
export const DEFAULT_CONCURRENCY = 3;

export const CHUNK_SIZE_BOUNDS = Object.freeze({
  min: MIN_CHUNK_SIZE,
  max: MAX_CHUNK_SIZE,
});

export type FolderStatus = 'active' | 'deleted';

export type ObjectStatus = 'uploading' | 'completed' | 'failed' | 'deleted';

export type UploadStatus =
  'created' | 'uploading' | 'paused' | 'verifying' | 'completed' | 'failed' | 'aborted' | 'deleted';

export type PartStatus = 'pending' | 'uploading' | 'committed' | 'failed';

export interface Folder {
  id: string;
  workspaceId: string;
  parentId: string | null;
  name: string;
  status: FolderStatus;
  createdAt: string;
  deletedAt: string | null;
}

export interface ObjectPartManifest {
  partNo: number;
  size: number;
  sha256: string;
  messageId: string;
  botFileId?: string;
  status: PartStatus;
}

export interface ObjectManifest {
  objectId: string;
  name: string;
  mimeType: string;
  size: number;
  sha256: string;
  chunkSize: number;
  partCount: number;
  status: ObjectStatus;
  parts: readonly ObjectPartManifest[];
}

export interface UploadSessionManifest {
  uploadId: string;
  objectId: string;
  status: UploadStatus;
  chunkSize: number;
  partCount: number;
  expiresAt: string;
  committedParts: readonly ObjectPartManifest[];
}

export type WorkspaceMemberRole = 'owner' | 'member';

export interface WorkspaceMember {
  userId: string;
  username: string | null;
  displayName: string | null;
  status?: 'pending' | 'active' | 'disabled';
  role: WorkspaceMemberRole;
  createdAt: string | null;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  ownerId: string;
  isOwner: boolean;
  members: readonly WorkspaceMember[];
}

export interface WorkspaceListResponse {
  workspaces: readonly WorkspaceSummary[];
}

export interface AddWorkspaceMemberRequest {
  userId: string;
}

export interface StartUploadRequest {
  name: string;
  size: number;
  mimeType: string;
  folderId: string | null;
  lastModified: number | null;
  partCount: number;
  chunkSize?: number;
  idempotencyKey: string;
}

export interface StartUploadResponse {
  uploadId: string;
  objectId: string;
  status: 'created';
  chunkSize: number;
  partCount: number;
  expiresAt: string;
}

export interface CommitPartRequest {
  partNo: number;
  size: number;
  sha256: string;
  messageId: string;
  botFileId?: string;
  idempotencyKey: string;
}

export interface CommitPartResponse {
  uploadId: string;
  part: ObjectPartManifest;
  status: UploadStatus;
}

export interface CompleteUploadRequest {
  sha256: string;
  size: number;
  idempotencyKey: string;
}

export interface CompleteUploadResponse {
  object: ObjectManifest;
  status: 'completed';
}

export interface AbortUploadResponse {
  uploadId: string;
  status: 'aborted';
}

export interface ValidationIssue {
  path: string;
  message: string;
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export function isValidChunkSize(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= MIN_CHUNK_SIZE && value <= MAX_CHUNK_SIZE;
}

export function assertValidChunkSize(value: unknown): asserts value is number {
  if (!isValidChunkSize(value)) {
    throw new RangeError(`chunk size must be an integer between ${MIN_CHUNK_SIZE} and ${MAX_CHUNK_SIZE}`);
  }
}

export function assertValidPartNumber(partNo: unknown, partCount: number): asserts partNo is number {
  if (!Number.isSafeInteger(partCount) || partCount < 0) {
    throw new RangeError('part count must be a non-negative safe integer');
  }
  if (typeof partNo !== 'number' || !Number.isSafeInteger(partNo) || partNo < 0 || partNo >= partCount) {
    throw new RangeError(`part number must be between 0 and ${Math.max(0, partCount - 1)}`);
  }
}

export function validateStartUploadRequest(input: unknown): ValidationIssue[] {
  if (typeof input !== 'object' || input === null) {
    return [{ path: '', message: 'request must be an object' }];
  }

  const request = input as Partial<StartUploadRequest>;
  const issues: ValidationIssue[] = [];

  if (typeof request.name !== 'string' || request.name.length === 0) {
    issues.push({ path: 'name', message: 'name must be a non-empty string' });
  }
  if (!Number.isSafeInteger(request.size) || (request.size as number) < 0) {
    issues.push({ path: 'size', message: 'size must be a non-negative safe integer' });
  }
  if (typeof request.mimeType !== 'string') {
    issues.push({ path: 'mimeType', message: 'mimeType must be a string' });
  }
  if (request.folderId !== null && typeof request.folderId !== 'string') {
    issues.push({ path: 'folderId', message: 'folderId must be a string or null' });
  }
  if (request.lastModified !== null && !Number.isSafeInteger(request.lastModified)) {
    issues.push({ path: 'lastModified', message: 'lastModified must be an integer or null' });
  }
  if (!Number.isSafeInteger(request.partCount) || (request.partCount as number) < 0) {
    issues.push({ path: 'partCount', message: 'partCount must be a non-negative safe integer' });
  }
  if (request.chunkSize !== undefined && !isValidChunkSize(request.chunkSize)) {
    issues.push({ path: 'chunkSize', message: 'chunkSize is outside supported bounds' });
  }
  if (typeof request.idempotencyKey !== 'string' || request.idempotencyKey.length === 0) {
    issues.push({ path: 'idempotencyKey', message: 'idempotencyKey must be a non-empty string' });
  }

  return issues;
}

export function isSha256(value: unknown): value is string {
  return typeof value === 'string' && SHA256_PATTERN.test(value);
}
