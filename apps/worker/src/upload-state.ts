export type UploadStatus = 'created' | 'uploading' | 'paused' | 'verifying' | 'completed' | 'failed' | 'aborted';

export function uploadIsOpen(status: string, expiresAt: string, at: string): boolean {
  return ['created', 'uploading', 'paused', 'verifying'].includes(status) && expiresAt > at;
}

export function canCommitPart(
  uploadStatus: string,
  objectStatus: string,
  deletedAt: string | null,
  expiresAt: string,
  at: string,
): boolean {
  return (
    ['created', 'uploading', 'paused'].includes(uploadStatus) &&
    expiresAt > at &&
    objectStatus === 'uploading' &&
    deletedAt === null
  );
}

export function canComplete(
  uploadStatus: string,
  objectStatus: string,
  deletedAt: string | null,
  expiresAt: string,
  at: string,
): boolean {
  return uploadIsOpen(uploadStatus, expiresAt, at) && objectStatus === 'uploading' && deletedAt === null;
}

export function canAbort(uploadStatus: string, objectStatus: string, deletedAt: string | null): boolean {
  return (
    ['created', 'uploading', 'paused', 'verifying', 'failed'].includes(uploadStatus) &&
    objectStatus === 'uploading' &&
    deletedAt === null
  );
}
