import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMultipartStream, StreamingBodyError } from '../src/bot-transfer';

type DigestStreamConstructor = new (algorithm: string) => WritableStream<Uint8Array> & {
  digest: Promise<ArrayBuffer>;
};

class TestDigestStream extends WritableStream<Uint8Array> {
  readonly digest: Promise<ArrayBuffer>;

  constructor(algorithm: string) {
    if (algorithm !== 'SHA-256') throw new Error(`Unsupported digest algorithm: ${algorithm}`);

    const chunks: Uint8Array[] = [];
    let resolveDigest!: (digest: ArrayBuffer) => void;
    let rejectDigest!: (reason?: unknown) => void;
    const digest = new Promise<ArrayBuffer>((resolve, reject) => {
      resolveDigest = resolve;
      rejectDigest = reject;
    });
    super({
      write(chunk) {
        chunks.push(new Uint8Array(chunk));
      },
      async close() {
        try {
          const bytes = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0));
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
          }
          resolveDigest(await globalThis.crypto.subtle.digest('SHA-256', bytes));
        } catch (error) {
          rejectDigest(error);
          throw error;
        }
      },
      abort: rejectDigest,
    });
    this.digest = digest;
  }
}

const cryptoWithDigestStream = globalThis.crypto as typeof globalThis.crypto & {
  DigestStream?: DigestStreamConstructor;
};
const originalDigestStream = cryptoWithDigestStream.DigestStream;

beforeAll(() => {
  cryptoWithDigestStream.DigestStream = TestDigestStream;
});

afterAll(() => {
  if (originalDigestStream) cryptoWithDigestStream.DigestStream = originalDigestStream;
  else delete cryptoWithDigestStream.DigestStream;
});

describe('Bot API streaming transfer helpers', () => {
  it('streams valid multipart framing', async () => {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('ab'));
        controller.enqueue(new TextEncoder().encode('c'));
        controller.close();
      },
    });
    const valid = createMultipartStream(
      source,
      'boundary',
      '-1001',
      'file.txt',
      'text/plain',
      3,
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      new AbortController().signal,
    );
    const body = await new Response(valid.stream).text();
    expect(body).toBe(
      '--boundary\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n-1001\r\n' +
        '--boundary\r\nContent-Disposition: form-data; name="document"; filename="file.txt"\r\n' +
        'Content-Type: text/plain\r\n\r\nabc\r\n--boundary--\r\n',
    );
    expect(valid.state).toMatchObject({
      bytesRead: 3,
      completed: true,
      sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    });
  });

  it('rejects checksum mismatch', async () => {
    const mismatch = createMultipartStream(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('abc'));
          controller.close();
        },
      }),
      'boundary',
      '-1001',
      'file.txt',
      'text/plain',
      3,
      '0'.repeat(64),
      new AbortController().signal,
    );

    await expect(new Response(mismatch.stream).text()).rejects.toBeInstanceOf(StreamingBodyError);
    expect(mismatch.state.error).toBeInstanceOf(StreamingBodyError);
  });

  it('rejects undersized source', async () => {
    const undersize = createMultipartStream(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('abc'));
          controller.close();
        },
      }),
      'boundary',
      '-1001',
      'file.txt',
      'text/plain',
      4,
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      new AbortController().signal,
    );

    await expect(new Response(undersize.stream).text()).rejects.toBeInstanceOf(StreamingBodyError);
    expect(undersize.state).toMatchObject({ bytesRead: 3, completed: false });
    expect(undersize.state.error).toBeInstanceOf(StreamingBodyError);
  });

  it('rejects oversized source before enqueueing it', async () => {
    const oversize = createMultipartStream(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('abc'));
          controller.close();
        },
      }),
      'boundary',
      '-1001',
      'file.txt',
      'text/plain',
      2,
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      new AbortController().signal,
    );

    await expect(new Response(oversize.stream).text()).rejects.toBeInstanceOf(StreamingBodyError);
    expect(oversize.state).toMatchObject({ bytesRead: 0, completed: false, sha256: '' });
    expect(oversize.state.error).toBeInstanceOf(StreamingBodyError);
  });
});
