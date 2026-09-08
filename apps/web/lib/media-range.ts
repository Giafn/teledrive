export type MediaManifestPart = { partNo: number; messageId: string; sha256: string; size: number };

export type MediaManifest = {
  objectId: string;
  mime: string;
  size: number;
  chunkSize: number;
  parts: MediaManifestPart[];
};

export type ParsedRange = { start: number; end: number };

const RANGE_PATTERN = /^bytes=(\d*)-(\d*)$/u;

export function parseRangeHeader(header: string | null, size: number): ParsedRange | 'invalid' | 'unsatisfiable' {
  if (!header) return 'invalid';
  const match = RANGE_PATTERN.exec(header.trim());
  if (!match) return 'invalid';
  const [, rawStart, rawEnd] = match;
  if (size <= 0) return 'unsatisfiable';
  if (rawStart === '' && rawEnd === '') return 'invalid';

  if (rawStart === '') {
    const suffix = Number(rawEnd);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return 'invalid';
    const start = Math.max(0, size - suffix);
    return { start, end: size - 1 };
  }

  const start = Number(rawStart);
  if (!Number.isSafeInteger(start) || start >= size) return start >= size ? 'unsatisfiable' : 'invalid';
  const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (!Number.isSafeInteger(end) || end < start) return 'invalid';
  return { start, end };
}

export function partsForRange(manifest: MediaManifest, range: ParsedRange): number[] {
  const partNumbers: number[] = [];
  let offset = 0;
  for (const part of manifest.parts) {
    const partStart = offset;
    const partEnd = offset + part.size - 1;
    offset += part.size;
    if (partStart <= range.end && partEnd >= range.start) partNumbers.push(part.partNo);
    if (partStart > range.end) break;
  }
  return partNumbers;
}

export function contentRange(range: ParsedRange, size: number): string {
  return `bytes ${range.start}-${range.end}/${size}`;
}
