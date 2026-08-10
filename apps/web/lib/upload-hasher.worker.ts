import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

type PartPlan = { partNo: number; offset: number; size: number; sha256: string };
type HashRequest = { type: 'hash'; file: Blob; chunkSize: number; paused?: boolean };
type WorkerRequest = HashRequest | { type: 'pause' } | { type: 'resume' } | { type: 'cancel' };
type WorkerScope = {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: unknown): void;
};

const scope = self as unknown as WorkerScope;
let paused = false;
let cancelled = false;
let resumeWaiters: Array<() => void> = [];

function waitUntilRunnable(): Promise<void> {
  if (!paused) return Promise.resolve();
  return new Promise((resolve) => resumeWaiters.push(resolve));
}

function resume(): void {
  paused = false;
  while (resumeWaiters.length) resumeWaiters.shift()?.();
}

async function hashFile(request: HashRequest): Promise<void> {
  const fullHash = sha256.create();
  const parts: PartPlan[] = [];
  const totalParts = request.file.size === 0 ? 0 : Math.ceil(request.file.size / request.chunkSize);
  for (let partNo = 0; partNo < totalParts; partNo += 1) {
    if (cancelled) throw new Error('Upload hashing cancelled');
    await waitUntilRunnable();
    if (cancelled) throw new Error('Upload hashing cancelled');
    const offset = partNo * request.chunkSize;
    const bytes = new Uint8Array(
      await request.file.slice(offset, Math.min(request.file.size, offset + request.chunkSize)).arrayBuffer(),
    );
    fullHash.update(bytes);
    parts.push({ partNo, offset, size: bytes.byteLength, sha256: bytesToHex(sha256(bytes)) });
    scope.postMessage({ type: 'progress', bytesHashed: offset + bytes.byteLength });
  }
  scope.postMessage({ type: 'result', sha256: bytesToHex(fullHash.digest()), parts });
}

scope.onmessage = (event) => {
  const request = event.data;
  if (request.type === 'pause') {
    paused = true;
    return;
  }
  if (request.type === 'resume') {
    resume();
    return;
  }
  if (request.type === 'cancel') {
    cancelled = true;
    resume();
    return;
  }
  paused = request.paused ?? false;
  cancelled = false;
  void hashFile(request).catch((error: unknown) => {
    scope.postMessage({ type: 'error', message: error instanceof Error ? error.message : 'Upload hashing failed' });
  });
};
