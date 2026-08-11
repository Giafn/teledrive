type CloudflareDigestStream = WritableStream<Uint8Array> & {
  digest: Promise<ArrayBuffer>;
};

function digestToHex(digest: ArrayBuffer): string {
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export class StreamingBodyError extends Error {}

export interface MultipartStreamState {
  bytesRead: number;
  completed: boolean;
  error?: StreamingBodyError;
  sha256: string;
}

export function createMultipartStream(
  source: ReadableStream<Uint8Array>,
  boundary: string,
  chatId: string,
  filename: string,
  mime: string,
  expectedSize: number,
  expectedSha256: string,
  signal: AbortSignal,
): { stream: ReadableStream<Uint8Array>; state: MultipartStreamState } {
  const encoder = new TextEncoder();
  const prefix = encoder.encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${filename}"\r\n` +
      `Content-Type: ${mime}\r\n\r\n`,
  );
  const suffix = encoder.encode(`\r\n--${boundary}--\r\n`);
  const DigestStream = (
    crypto as Crypto & {
      DigestStream: new (algorithm: string) => CloudflareDigestStream;
    }
  ).DigestStream;
  const digestStream = new DigestStream('SHA-256');
  const digestWriter = digestStream.getWriter();
  const digest = digestStream.digest;
  void digest.catch(() => undefined);
  const state: MultipartStreamState = { bytesRead: 0, completed: false, sha256: '' };
  const reader = source.getReader();
  let prefixSent = false;
  let suffixSent = false;
  let abortHandler: (() => void) | undefined;

  const cancelResources = async (reason: unknown): Promise<void> => {
    await Promise.all([
      reader.cancel(reason).catch(() => undefined),
      digestWriter.abort(reason).catch(() => undefined),
    ]);
  };

  const removeAbortHandler = () => {
    if (abortHandler) {
      signal.removeEventListener('abort', abortHandler);
      abortHandler = undefined;
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    start() {
      abortHandler = () => void cancelResources(signal.reason);
      if (signal.aborted) abortHandler();
      else signal.addEventListener('abort', abortHandler, { once: true });
    },
    async pull(controller) {
      try {
        if (!prefixSent) {
          prefixSent = true;
          controller.enqueue(prefix);
          return;
        }
        if (suffixSent) {
          controller.close();
          return;
        }
        const next = await reader.read();
        if (next.done) {
          await digestWriter.close();
          state.sha256 = digestToHex(await digest);
          if (state.bytesRead !== expectedSize || state.sha256 !== expectedSha256) {
            throw new StreamingBodyError('Streamed part does not match declared metadata');
          }
          suffixSent = true;
          state.completed = true;
          removeAbortHandler();
          controller.enqueue(suffix);
          return;
        }
        if (state.bytesRead + next.value.byteLength > expectedSize) {
          throw new StreamingBodyError('Streamed part exceeds declared size');
        }
        await digestWriter.ready;
        await digestWriter.write(next.value);
        state.bytesRead += next.value.byteLength;
        controller.enqueue(next.value);
      } catch (error) {
        const bodyError = error instanceof StreamingBodyError ? error : new StreamingBodyError('Streamed part failed');
        state.error = bodyError;
        removeAbortHandler();
        await cancelResources(bodyError);
        controller.error(bodyError);
      }
    },
    async cancel(reason) {
      removeAbortHandler();
      await cancelResources(reason);
    },
  });
  return { stream, state };
}
