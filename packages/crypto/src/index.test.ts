import { describe, expect, it } from 'vitest';
import { generateToken, hashToken, redact, sha256Hex } from './index';

describe('crypto utilities', () => {
  it('hashes known data with Web Crypto', async () => {
    await expect(sha256Hex('hello')).resolves.toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
    const view = new DataView(new Uint8Array([104, 101, 108, 108, 111]).buffer);
    await expect(sha256Hex(view)).resolves.toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });

  it('generates high-entropy URL-safe tokens and hashes them', async () => {
    const token = generateToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token.length).toBeGreaterThanOrEqual(22);
    await expect(hashToken(token)).resolves.toHaveLength(64);
    expect(generateToken()).not.toBe(token);
  });

  it('redacts secret-shaped fields without mutating input', () => {
    const input = { Authorization: 'Bearer abc', nested: { otp: '123456' }, url: '/s/x?token=secret' };
    const output = redact(input) as typeof input;
    expect(output).toEqual({
      Authorization: '[REDACTED]',
      nested: { otp: '[REDACTED]' },
      url: '/s/x?token=[REDACTED]',
    });
    expect(input.nested.otp).toBe('123456');
  });
});
