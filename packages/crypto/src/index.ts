export type HashInput = string | Blob | BufferSource;

function webCrypto(): Crypto {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.subtle || !cryptoApi.getRandomValues) {
    throw new Error('Web Crypto API is required');
  }
  return cryptoApi;
}

async function bytesFor(input: HashInput): Promise<Uint8Array> {
  if (typeof input === 'string') return new TextEncoder().encode(input);
  if (input instanceof Blob) return new Uint8Array(await input.arrayBuffer());
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  return new Uint8Array(input as ArrayBufferLike);
}

export async function sha256Bytes(input: HashInput): Promise<Uint8Array> {
  const bytes = await bytesFor(input);
  const digest = await webCrypto().subtle.digest('SHA-256', bytes as BufferSource);
  return new Uint8Array(digest);
}

export async function sha256Hex(input: HashInput): Promise<string> {
  const digest = await sha256Bytes(input);
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function sha256(input: HashInput): Promise<string> {
  return sha256Hex(input);
}

export function generateToken(byteLength = 32): string {
  if (!Number.isSafeInteger(byteLength) || byteLength < 16) {
    throw new RangeError('token must contain at least 128 bits of randomness');
  }
  const bytes = new Uint8Array(byteLength);
  webCrypto().getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export async function hashToken(token: string): Promise<string> {
  if (token.length === 0) throw new RangeError('token must not be empty');
  return sha256Hex(token);
}

export const REDACTED = '[REDACTED]';

const SENSITIVE_KEY =
  /(authorization|cookie|set-cookie|token|password|passcode|otp|phone|secret|session|auth.?key|file.?id|api.?key)/i;
const SENSITIVE_STRING = /((?:bearer|basic)\s+)[^\s,;]+/gi;
const QUERY_SECRET = /([?&](?:token|share_token|authorization|password)=)[^&#\s]+/gi;

export function redact(value: unknown): unknown {
  return redactValue(value, new WeakSet<object>());
}

export const redactSecrets = redact;

function redactValue(value: unknown, seen: WeakSet<object>, key?: string): unknown {
  if (key && SENSITIVE_KEY.test(key)) return REDACTED;
  if (typeof value === 'string') {
    return value.replace(SENSITIVE_STRING, `$1${REDACTED}`).replace(QUERY_SECRET, `$1${REDACTED}`);
  }
  if (typeof value !== 'object' || value === null) return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (Array.isArray(value)) return value.map((item) => redactValue(item, seen));
  const output: Record<string, unknown> = {};
  for (const [entryKey, entryValue] of Object.entries(value)) {
    output[entryKey] = redactValue(entryValue, seen, entryKey);
  }
  return output;
}
