export const MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024;
export const THUMBNAIL_MIME_TYPES = ['image/jpeg', 'image/webp'] as const;

export type ThumbnailMime = (typeof THUMBNAIL_MIME_TYPES)[number];

export type ThumbnailReference = {
  messageId: string;
  mime: ThumbnailMime;
  size: number;
  sha256: string;
};

export type ThumbnailRow = {
  thumbnail_message_id: string | null;
  thumbnail_mime: string | null;
  thumbnail_size: number | null;
  thumbnail_sha256: string | null;
};

export type ThumbnailValidation =
  | { valid: true; thumbnail: ThumbnailReference }
  | { valid: false; code: string; message: string };

const MESSAGE_ID = /^[1-9]\d{0,63}$/u;
const SHA256 = /^[a-f\d]{64}$/iu;

function fieldError(code: string, field: string): ThumbnailValidation {
  return { valid: false, code, message: `${field} is invalid for an object thumbnail` };
}

export function validateThumbnailInput(body: Record<string, unknown>): ThumbnailValidation {
  const rawMessageId = body.messageId;
  if (typeof rawMessageId !== 'string' || !MESSAGE_ID.test(rawMessageId)) {
    return fieldError('INVALID_FIELD', 'messageId');
  }
  const rawMime = body.mime;
  if (
    typeof rawMime !== 'string' ||
    !THUMBNAIL_MIME_TYPES.includes(rawMime.trim().toLowerCase() as ThumbnailMime)
  ) {
    return fieldError('INVALID_FIELD', 'mime');
  }
  const mime = rawMime.trim().toLowerCase() as ThumbnailMime;
  const rawSize = body.size;
  if (
    typeof rawSize !== 'number' ||
    !Number.isSafeInteger(rawSize) ||
    rawSize < 1 ||
    rawSize > MAX_THUMBNAIL_BYTES
  ) {
    return fieldError('INVALID_FIELD', 'size');
  }
  const rawSha256 = body.sha256;
  if (typeof rawSha256 !== 'string' || !SHA256.test(rawSha256.trim().toLowerCase())) {
    return fieldError('INVALID_HASH', 'sha256');
  }
  return {
    valid: true,
    thumbnail: { messageId: rawMessageId, mime, size: rawSize, sha256: rawSha256.trim().toLowerCase() },
  };
}

export function thumbnailResponse(row: ThumbnailRow | null | undefined): ThumbnailReference | null {
  if (!row) return null;
  const { thumbnail_message_id, thumbnail_mime, thumbnail_size, thumbnail_sha256 } = row;
  if (
    !thumbnail_message_id ||
    !thumbnail_mime ||
    typeof thumbnail_size !== 'number' ||
    !thumbnail_sha256 ||
    !THUMBNAIL_MIME_TYPES.includes(thumbnail_mime as ThumbnailMime) ||
    !MESSAGE_ID.test(thumbnail_message_id) ||
    !SHA256.test(thumbnail_sha256)
  ) {
    return null;
  }
  return {
    messageId: thumbnail_message_id,
    mime: thumbnail_mime as ThumbnailMime,
    size: thumbnail_size,
    sha256: thumbnail_sha256,
  };
}

export function sameThumbnail(left: ThumbnailReference, right: ThumbnailReference): boolean {
  return (
    left.messageId === right.messageId &&
    left.mime === right.mime &&
    left.size === right.size &&
    left.sha256 === right.sha256
  );
}
