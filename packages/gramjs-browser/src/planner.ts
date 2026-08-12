import { MAX_LOGICAL_PARTS, PROTOCOL_CHUNK_BYTES, selectFilePartCap } from './contracts.ts';
import type { AccountTier, NormalizedTransferConfig } from './contracts.ts';

export const MAX_OBJECT_BYTES = 10 * 1024 * 1024 * 1024;
export const LOGICAL_PART_BYTES = 64 * 1024 * 1024;
export const SMALL_FILE_LIMIT_BYTES = 10 * 1024 * 1024;

export type ProtocolChunk = Readonly<{
  logicalPartIndex: number;
  protocolPartIndex: number;
  offsetBytes: number;
  sizeBytes: number;
  final: boolean;
}>;

export type LogicalPart = Readonly<{
  index: number;
  offsetBytes: number;
  sizeBytes: number;
  protocolChunkCount: number;
  uploadMode: 'saveFilePart' | 'saveBigFilePart';
  requiresMd5: boolean;
  protocolChunks(): IterableIterator<ProtocolChunk>;
}>;

export type UploadPlan = Readonly<{
  source: 'live' | 'mock';
  tier: 'default' | 'premium';
  sizeBytes: number;
  logicalPartCount: number;
  logicalPartBytes: number;
  protocolChunkBytes: number;
  parts: readonly LogicalPart[];
}>;

function requireSize(value: unknown, label: string, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > maximum)
    throw new Error(`${label} is invalid`);
  return value;
}

export function isValidProtocolChunkSize(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 1024 &&
    value <= PROTOCOL_CHUNK_BYTES &&
    value % 1024 === 0 &&
    PROTOCOL_CHUNK_BYTES % value === 0
  );
}

function* protocolChunks(logicalPartIndex: number, offsetBytes: number, sizeBytes: number): IterableIterator<ProtocolChunk> {
  let consumed = 0;
  let protocolPartIndex = 0;
  while (consumed < sizeBytes) {
    const chunkSize = Math.min(PROTOCOL_CHUNK_BYTES, sizeBytes - consumed);
    yield Object.freeze({
      logicalPartIndex,
      protocolPartIndex,
      offsetBytes: offsetBytes + consumed,
      sizeBytes: chunkSize,
      final: consumed + chunkSize === sizeBytes,
    });
    consumed += chunkSize;
    protocolPartIndex += 1;
  }
}

export function planUpload(sizeBytes: unknown, config: NormalizedTransferConfig, tier: AccountTier = 'unknown'): UploadPlan {
  const size = requireSize(sizeBytes, 'object size', MAX_OBJECT_BYTES);
  const logicalPartCount = Math.ceil(size / LOGICAL_PART_BYTES);
  if (logicalPartCount > MAX_LOGICAL_PARTS) throw new Error('logical part cap is exceeded');
  const selectedTier = tier === 'premium' ? 'premium' : 'default';
  const configuredCap = selectFilePartCap(config, tier);

  const parts = Array.from({ length: logicalPartCount }, (_, index) => {
    const offsetBytes = index * LOGICAL_PART_BYTES;
    const partSize = Math.min(LOGICAL_PART_BYTES, size - offsetBytes);
    const protocolChunkCount = Math.ceil(partSize / PROTOCOL_CHUNK_BYTES);
    if (protocolChunkCount > configuredCap) throw new Error('configured per-file protocol part cap is exceeded');
    const uploadMode = partSize > SMALL_FILE_LIMIT_BYTES ? 'saveBigFilePart' : 'saveFilePart';
    return Object.freeze({
      index,
      offsetBytes,
      sizeBytes: partSize,
      protocolChunkCount,
      uploadMode,
      requiresMd5: uploadMode === 'saveFilePart',
      protocolChunks: () => protocolChunks(index, offsetBytes, partSize),
    });
  });

  return Object.freeze({
    source: config.source,
    tier: selectedTier,
    sizeBytes: size,
    logicalPartCount,
    logicalPartBytes: LOGICAL_PART_BYTES,
    protocolChunkBytes: PROTOCOL_CHUNK_BYTES,
    parts: Object.freeze(parts),
  });
}
