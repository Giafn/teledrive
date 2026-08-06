import { describe, expect, it } from 'vitest';
import { coerceD1PublicKey, constantTimeEqual, isExactOrigin, redactJson } from '../src/security';

describe('security helpers', () => {
  it('requires exact configured origin', () => {
    expect(isExactOrigin('https://drive.example.com', 'https://drive.example.com')).toBe(true);
    expect(isExactOrigin('https://evil.example', 'https://drive.example.com')).toBe(false);
    expect(isExactOrigin(undefined, 'https://drive.example.com')).toBe(false);
  });

  it('redacts secret-shaped JSON keys', () => {
    expect(redactJson({ requestId: 'r1', token: 'x', nested: { password: 'y' } })).toEqual({
      requestId: 'r1',
      token: '[REDACTED]',
      nested: { password: '[REDACTED]' },
    });
  });

  it('compares unequal lengths without early return', () => {
    expect(constantTimeEqual('same', 'same')).toBe(true);
    expect(constantTimeEqual('same', 'different')).toBe(false);
  });

  it('round-trips D1-like number-array public keys safely', () => {
    const source = new Uint8Array([0, 1, 127, 254, 255]);
    const restored = coerceD1PublicKey(Array.from(source));
    expect(Array.from(restored)).toEqual(Array.from(source));
    expect(() => coerceD1PublicKey([0, 256])).toThrow();
  });
});
