export interface ManifestPart {
  partNo: number;
  size: number;
  sha256: string;
  messageId: string;
  idempotencyKey: string;
}

export interface ManifestInput {
  expectedPartCount: number;
  expectedSize: number;
  expectedSha256?: string | null;
  parts: ManifestPart[];
  requestedPartCount: number;
  requestedSize: number;
  requestedSha256?: string | null;
}

export interface ManifestValidation {
  valid: boolean;
  reason?: string;
}

const SHA256 = /^[a-f0-9]{64}$/u;

export function validateManifest(input: ManifestInput): ManifestValidation {
  if (!Number.isSafeInteger(input.expectedPartCount) || input.expectedPartCount < 0) {
    return { valid: false, reason: 'invalid expected part count' };
  }
  if (input.requestedPartCount !== input.expectedPartCount) return { valid: false, reason: 'part count mismatch' };
  if (input.requestedSize !== input.expectedSize || input.requestedSize < 0) {
    return { valid: false, reason: 'size mismatch' };
  }
  if (input.expectedSha256 && !SHA256.test(input.expectedSha256))
    return { valid: false, reason: 'invalid object hash' };
  if (input.requestedSha256 && !SHA256.test(input.requestedSha256))
    return { valid: false, reason: 'invalid requested hash' };
  if ((input.expectedSha256 ?? null) !== (input.requestedSha256 ?? null)) {
    return { valid: false, reason: 'object hash mismatch' };
  }
  if (input.parts.length !== input.expectedPartCount) return { valid: false, reason: 'missing parts' };

  let total = 0;
  for (const [index, part] of input.parts.entries()) {
    if (part.partNo !== index) return { valid: false, reason: 'parts are not contiguous' };
    if (!Number.isSafeInteger(part.size) || part.size < 0 || !SHA256.test(part.sha256)) {
      return { valid: false, reason: 'invalid part metadata' };
    }
    if (!part.messageId || !part.idempotencyKey) return { valid: false, reason: 'missing part identity' };
    total += part.size;
    if (!Number.isSafeInteger(total)) return { valid: false, reason: 'size overflow' };
  }
  return total === input.expectedSize ? { valid: true } : { valid: false, reason: 'part sizes mismatch' };
}
