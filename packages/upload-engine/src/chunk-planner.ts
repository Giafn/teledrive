import { CHUNK_SIZE, assertValidChunkSize } from '@teledrive/contracts';

export interface PlannedChunk {
  index: number;
  offset: number;
  size: number;
}

export function chunkCount(fileSize: number, chunkSize = CHUNK_SIZE): number {
  assertFileSize(fileSize);
  assertValidChunkSize(chunkSize);
  return fileSize === 0 ? 0 : Math.ceil(fileSize / chunkSize);
}

export function planChunks(fileSize: number, chunkSize = CHUNK_SIZE): PlannedChunk[] {
  assertFileSize(fileSize);
  assertValidChunkSize(chunkSize);

  const count = chunkCount(fileSize, chunkSize);
  return Array.from({ length: count }, (_, index) => {
    const offset = index * chunkSize;
    return {
      index,
      offset,
      size: Math.min(chunkSize, fileSize - offset),
    };
  });
}

function assertFileSize(fileSize: number): void {
  if (!Number.isSafeInteger(fileSize) || fileSize < 0) {
    throw new RangeError('file size must be a non-negative safe integer');
  }
}
