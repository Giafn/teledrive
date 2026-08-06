import { describe, expect, it } from 'vitest';
import { validateManifest } from '../src/manifest';

const hash = 'a'.repeat(64);

describe('manifest invariants', () => {
  it('accepts contiguous parts with exact total', () => {
    expect(
      validateManifest({
        expectedPartCount: 2,
        expectedSize: 5,
        expectedSha256: hash,
        requestedPartCount: 2,
        requestedSize: 5,
        requestedSha256: hash,
        parts: [
          { partNo: 0, size: 3, sha256: hash, messageId: 'm0', idempotencyKey: 'p0' },
          { partNo: 1, size: 2, sha256: hash, messageId: 'm1', idempotencyKey: 'p1' },
        ],
      }),
    ).toEqual({ valid: true });
  });

  it('rejects gaps and duplicate ordering', () => {
    expect(
      validateManifest({
        expectedPartCount: 2,
        expectedSize: 5,
        requestedPartCount: 2,
        requestedSize: 5,
        parts: [
          { partNo: 0, size: 3, sha256: hash, messageId: 'm0', idempotencyKey: 'p0' },
          { partNo: 2, size: 2, sha256: hash, messageId: 'm2', idempotencyKey: 'p2' },
        ],
      }),
    ).toEqual({ valid: false, reason: 'parts are not contiguous' });
  });
});
