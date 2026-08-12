export const PROTOCOL_CHUNK_BYTES = 512 * 1024;
export const MAX_LOGICAL_PARTS = 160;

export type AccountTier = 'default' | 'premium' | 'unknown';

export type TransferConfigInput = Readonly<{
  source: unknown;
  uploadMaxFilePartsDefault: unknown;
  uploadMaxFilePartsPremium: unknown;
  smallQueueMaxActiveOperations: unknown;
  largeQueueMaxActiveOperations: unknown;
  fetchedAt: unknown;
  schemaVersion: unknown;
}>;

export type NormalizedTransferConfig = Readonly<{
  source: 'live' | 'mock';
  uploadMaxFilePartsDefault: number;
  uploadMaxFilePartsPremium: number;
  smallQueueMaxActiveOperations: number;
  largeQueueMaxActiveOperations: number;
  fetchedAt: string;
  schemaVersion: string;
}>;

function positiveSafeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${label} must be a positive safe integer`);
  return value;
}

export function normalizeTransferConfig(input: TransferConfigInput): NormalizedTransferConfig {
  if (input.source !== 'live' && input.source !== 'mock') throw new Error('transfer config source is invalid');
  if (typeof input.fetchedAt !== 'string' || Number.isNaN(Date.parse(input.fetchedAt)))
    throw new Error('transfer config retrieval time is invalid');
  if (typeof input.schemaVersion !== 'string' || input.schemaVersion.length === 0)
    throw new Error('transfer config schema version is invalid');
  return Object.freeze({
    source: input.source,
    uploadMaxFilePartsDefault: positiveSafeInteger(input.uploadMaxFilePartsDefault, 'default file part cap'),
    uploadMaxFilePartsPremium: positiveSafeInteger(input.uploadMaxFilePartsPremium, 'premium file part cap'),
    smallQueueMaxActiveOperations: positiveSafeInteger(input.smallQueueMaxActiveOperations, 'small queue cap'),
    largeQueueMaxActiveOperations: positiveSafeInteger(input.largeQueueMaxActiveOperations, 'large queue cap'),
    fetchedAt: input.fetchedAt,
    schemaVersion: input.schemaVersion,
  });
}

export function selectFilePartCap(config: NormalizedTransferConfig, tier: AccountTier): number {
  return tier === 'premium' ? config.uploadMaxFilePartsPremium : config.uploadMaxFilePartsDefault;
}

export type ByteSource = Readonly<{
  sizeBytes: number;
  read(offsetBytes: number, lengthBytes: number): Promise<Uint8Array>;
}>;

export type ByteSink = Readonly<{
  write(bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(reason: unknown): Promise<void>;
}>;

export type ByteSpan = Readonly<{ offsetBytes: number; sizeBytes: number }>;

function validateSpan(span: ByteSpan, sourceSize: number, maximumSize: number): void {
  if (!Number.isSafeInteger(span.offsetBytes) || span.offsetBytes < 0) throw new Error('byte source offset is invalid');
  if (!Number.isSafeInteger(span.sizeBytes) || span.sizeBytes <= 0 || span.sizeBytes > maximumSize)
    throw new Error('byte source read exceeds protocol chunk');
  if (span.offsetBytes + span.sizeBytes > sourceSize) throw new Error('byte source read exceeds known size');
}

export function createGuardedByteSource(source: ByteSource, maxReadBytes = PROTOCOL_CHUNK_BYTES): ByteSource {
  if (!Number.isSafeInteger(source.sizeBytes) || source.sizeBytes < 0) throw new Error('byte source size is invalid');
  if (!Number.isSafeInteger(maxReadBytes) || maxReadBytes <= 0 || maxReadBytes > PROTOCOL_CHUNK_BYTES)
    throw new Error('guarded read limit is invalid');
  let reading = false;
  return Object.freeze({
    sizeBytes: source.sizeBytes,
    async read(offsetBytes: number, lengthBytes: number): Promise<Uint8Array> {
      if (reading) throw new Error('byte source reads must be serial');
      validateSpan({ offsetBytes, sizeBytes: lengthBytes }, source.sizeBytes, maxReadBytes);
      reading = true;
      try {
        const bytes = await source.read(offsetBytes, lengthBytes);
        if (!(bytes instanceof Uint8Array) || bytes.byteLength !== lengthBytes)
          throw new Error('byte source returned an unexpected length');
        return bytes;
      } finally {
        reading = false;
      }
    },
  });
}

export function validateWholeFileMd5(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{32}$/iu.test(value)) throw new Error('small-file whole-file MD5 is required');
  return value;
}

export const validateSmallFilePartMd5 = validateWholeFileMd5;

export type InputFile = Readonly<{
  kind: 'small';
  fileId: bigint;
  parts: number;
  md5Checksum: string;
}>;

export type InputFileBig = Readonly<{
  kind: 'big';
  fileId: bigint;
  parts: number;
}>;

export type DocumentFileDescriptor = InputFile | InputFileBig;

const SMALL_FILE_LIMIT_BYTES = 10 * 1024 * 1024;

function validateDescriptorBase(fileId: unknown, parts: unknown): void {
  if (typeof fileId !== 'bigint' || fileId < -(2n ** 63n) || fileId > 2n ** 63n - 1n)
    throw new Error('document file id must be a signed 64-bit bigint');
  if (typeof parts !== 'number' || !Number.isSafeInteger(parts) || parts <= 0) throw new Error('document part count is invalid');
}

export function createDocumentFileDescriptor(input: {
  fileId: bigint;
  parts: number;
  sizeBytes: number;
  wholeFileMd5?: unknown;
}): DocumentFileDescriptor {
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes <= 0) throw new Error('document size is invalid');
  validateDescriptorBase(input.fileId, input.parts);
  if (input.sizeBytes <= SMALL_FILE_LIMIT_BYTES)
    return Object.freeze({ kind: 'small', fileId: input.fileId, parts: input.parts, md5Checksum: validateWholeFileMd5(input.wholeFileMd5) });
  if (input.wholeFileMd5 !== undefined) throw new Error('big document descriptor must not include MD5');
  return Object.freeze({ kind: 'big', fileId: input.fileId, parts: input.parts });
}

export function validateDocumentFileDescriptor(value: unknown): DocumentFileDescriptor {
  if (!value || typeof value !== 'object') throw new Error('document file descriptor is invalid');
  const descriptor = value as Partial<DocumentFileDescriptor>;
  validateDescriptorBase(descriptor.fileId, descriptor.parts);
  if (descriptor.kind === 'small') {
    validateWholeFileMd5(descriptor.md5Checksum);
    return descriptor as InputFile;
  }
  if (descriptor.kind === 'big' && !('md5Checksum' in descriptor)) return descriptor as InputFileBig;
  throw new Error('document file descriptor is invalid');
}

export type RawMtprotoTransport = Readonly<{
  getTransferConfig(): Promise<NormalizedTransferConfig>;
  saveFilePart(request: Readonly<{ fileId: bigint; partIndex: number; bytes: Uint8Array }>): Promise<void>;
  saveBigFilePart(
    request: Readonly<{ fileId: bigint; partIndex: number; totalParts: number; bytes: Uint8Array }>,
  ): Promise<void>;
  sendDocument(request: Readonly<{ descriptor: DocumentFileDescriptor; filename: string; randomId: bigint }>): Promise<void>;
  readDocumentChunk(request: Readonly<{ offsetBytes: number; limitBytes: number }>): Promise<Uint8Array>;
  refetchBoundDocument(): Promise<'matched' | 'missing' | 'mismatched'>;
  disconnect(): Promise<void>;
}>;
