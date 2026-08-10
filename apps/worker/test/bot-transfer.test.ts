import { describe, expect, it } from 'vitest';
import { createMultipartStream, Sha256Stream, StreamingBodyError } from '../src/bot-transfer';

describe('Bot API streaming transfer helpers', () => {
  it('computes SHA-256 incrementally', () => {
    const hash = new Sha256Stream();
    hash.update(new TextEncoder().encode('a'));
    hash.update(new TextEncoder().encode('bc'));
    expect(hash.digest()).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('streams multipart framing and rejects byte or checksum mismatch', async () => {
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
    expect(body).toContain('name="chat_id"');
    expect(body).toContain('filename="file.txt"');
    expect(valid.state).toMatchObject({ bytesRead: 3, completed: true });

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
});
