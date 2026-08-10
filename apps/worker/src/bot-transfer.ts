const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
  0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
  0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
]);

function rotr(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

export class Sha256Stream {
  private readonly state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  private readonly block = new Uint8Array(64);
  private blockLength = 0;
  private byteLength = 0;

  update(bytes: Uint8Array): void {
    this.byteLength += bytes.byteLength;
    let offset = 0;
    while (offset < bytes.byteLength) {
      const length = Math.min(64 - this.blockLength, bytes.byteLength - offset);
      this.block.set(bytes.subarray(offset, offset + length), this.blockLength);
      this.blockLength += length;
      offset += length;
      if (this.blockLength === 64) {
        this.compress(this.block);
        this.blockLength = 0;
      }
    }
  }

  digest(): string {
    const state = new Uint32Array(this.state);
    const block = new Uint8Array(this.block);
    let blockLength = this.blockLength;
    block[blockLength++] = 0x80;
    if (blockLength > 56) {
      block.fill(0, blockLength);
      this.compressWithState(block, state);
      block.fill(0);
      blockLength = 0;
    }
    block.fill(0, blockLength, 56);
    const bitLength = this.byteLength * 8;
    const high = Math.floor(bitLength / 0x100000000);
    block[56] = (high >>> 24) & 0xff;
    block[57] = (high >>> 16) & 0xff;
    block[58] = (high >>> 8) & 0xff;
    block[59] = high & 0xff;
    block[60] = (bitLength >>> 24) & 0xff;
    block[61] = (bitLength >>> 16) & 0xff;
    block[62] = (bitLength >>> 8) & 0xff;
    block[63] = bitLength & 0xff;
    this.compressWithState(block, state);
    return Array.from(state, (value) => value.toString(16).padStart(8, '0')).join('');
  }

  private compress(block: Uint8Array): void {
    this.compressWithState(block, this.state);
  }

  private compressWithState(block: Uint8Array, state: Uint32Array): void {
    const schedule = new Uint32Array(64);
    for (let index = 0; index < 16; index += 1) {
      const offset = index * 4;
      schedule[index] =
        (block[offset] << 24) | (block[offset + 1] << 16) | (block[offset + 2] << 8) | block[offset + 3];
    }
    for (let index = 16; index < 64; index += 1) {
      const value = schedule[index - 15];
      const smallSigma0 = rotr(value, 7) ^ rotr(value, 18) ^ (value >>> 3);
      const previous = schedule[index - 2];
      const smallSigma1 = rotr(previous, 17) ^ rotr(previous, 19) ^ (previous >>> 10);
      schedule[index] = (schedule[index - 16] + smallSigma0 + schedule[index - 7] + smallSigma1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = state;
    for (let index = 0; index < 64; index += 1) {
      const bigSigma1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temporary1 = (h + bigSigma1 + choice + SHA256_K[index] + schedule[index]) >>> 0;
      const bigSigma0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temporary2 = (bigSigma0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) >>> 0;
    }
    state[0] = (state[0] + a) >>> 0;
    state[1] = (state[1] + b) >>> 0;
    state[2] = (state[2] + c) >>> 0;
    state[3] = (state[3] + d) >>> 0;
    state[4] = (state[4] + e) >>> 0;
    state[5] = (state[5] + f) >>> 0;
    state[6] = (state[6] + g) >>> 0;
    state[7] = (state[7] + h) >>> 0;
  }
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
  const hasher = new Sha256Stream();
  const state: MultipartStreamState = { bytesRead: 0, completed: false, sha256: '' };
  const reader = source.getReader();
  let prefixSent = false;
  let suffixSent = false;
  let abortHandler: (() => void) | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start() {
      abortHandler = () => void reader.cancel(signal.reason);
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
          state.sha256 = hasher.digest();
          if (state.bytesRead !== expectedSize || state.sha256 !== expectedSha256) {
            throw new StreamingBodyError('Streamed part does not match declared metadata');
          }
          suffixSent = true;
          state.completed = true;
          controller.enqueue(suffix);
          return;
        }
        if (state.bytesRead + next.value.byteLength > expectedSize) {
          throw new StreamingBodyError('Streamed part exceeds declared size');
        }
        state.bytesRead += next.value.byteLength;
        hasher.update(next.value);
        controller.enqueue(next.value);
      } catch (error) {
        const bodyError = error instanceof StreamingBodyError ? error : new StreamingBodyError('Streamed part failed');
        state.error = bodyError;
        await reader.cancel(bodyError).catch(() => undefined);
        controller.error(bodyError);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => undefined);
    },
  });
  return { stream, state };
}
