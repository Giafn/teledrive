const textEncoder = new TextEncoder();

export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

export function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

export function randomToken(length = 32): string {
  return base64url(randomBytes(length));
}

export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function sha256(value: string | ArrayBuffer | Uint8Array): Promise<string> {
  const data = typeof value === 'string' ? textEncoder.encode(value) : value;
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', data as BufferSource)));
}

export async function secretHash(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return hex(new Uint8Array(await crypto.subtle.sign('HMAC', key, textEncoder.encode(value))));
}

export function constantTimeEqual(left: string, right: string): boolean {
  const a = textEncoder.encode(left);
  const b = textEncoder.encode(right);
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return difference === 0;
}

export function coerceD1PublicKey(value: unknown): Uint8Array<ArrayBuffer> {
  if (Array.isArray(value)) {
    if (value.length > 1024 * 1024) throw new TypeError('D1 public key byte array is too large');
    const bytes = new Uint8Array(value.length);
    for (let index = 0; index < value.length; index += 1) {
      const byte = value[index];
      if (typeof byte !== 'number' || !Number.isInteger(byte) || byte < 0 || byte > 255) {
        throw new TypeError('D1 public key byte array is invalid');
      }
      bytes[index] = byte;
    }
    return bytes;
  }
  if (value instanceof Uint8Array) {
    const copy = new Uint8Array(value.byteLength);
    copy.set(value);
    return copy;
  }
  if (value instanceof ArrayBuffer) {
    const copy = new Uint8Array(value.byteLength);
    copy.set(new Uint8Array(value));
    return copy;
  }
  if (ArrayBuffer.isView(value)) {
    const copy = new Uint8Array(value.byteLength);
    copy.set(new Uint8Array(value.buffer as ArrayBuffer, value.byteOffset, value.byteLength));
    return copy;
  }
  throw new TypeError('D1 public key blob is invalid');
}

export function isExactOrigin(origin: string | undefined, expected: string): boolean {
  return origin === expected;
}

const secretKey = /(authorization|cookie|csrf|token|secret|password|otp|phone|auth.?key|file.?id)/iu;

export function redactJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, secretKey.test(key) ? '[REDACTED]' : redactJson(child)]),
  );
}

export function cookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    if (key === name) {
      try {
        return decodeURIComponent(part.slice(separator + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

export function serializeCookie(
  name: string,
  value: string,
  options: { httpOnly?: boolean; maxAge?: number; sameSite?: 'Lax' | 'Strict'; secure?: boolean } = {},
): string {
  const attributes = [`${name}=${encodeURIComponent(value)}`, 'Path=/'];
  if (options.maxAge !== undefined) attributes.push(`Max-Age=${options.maxAge}`);
  if (options.httpOnly) attributes.push('HttpOnly');
  if (options.secure !== false) attributes.push('Secure');
  attributes.push(`SameSite=${options.sameSite ?? 'Lax'}`);
  return attributes.join('; ');
}
