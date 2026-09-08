import { describe, expect, it } from 'vitest';
import { contentRange, parseRangeHeader, partsForRange, type MediaManifest } from './media-range';

const manifest: MediaManifest = {
  objectId: 'object-1',
  mime: 'video/mp4',
  size: 45,
  chunkSize: 20,
  parts: [
    { partNo: 0, messageId: '11', sha256: 'a'.repeat(64), size: 20 },
    { partNo: 1, messageId: '12', sha256: 'b'.repeat(64), size: 20 },
    { partNo: 2, messageId: '13', sha256: 'c'.repeat(64), size: 5 },
  ],
};

describe('parseRangeHeader', () => {
  it('parses bounded ranges and clamps the end to the object size', () => {
    expect(parseRangeHeader('bytes=0-19', 45)).toEqual({ start: 0, end: 19 });
    expect(parseRangeHeader('bytes=10-999', 45)).toEqual({ start: 10, end: 44 });
    expect(parseRangeHeader('bytes=44-44', 45)).toEqual({ start: 44, end: 44 });
  });

  it('parses open-ended and suffix ranges', () => {
    expect(parseRangeHeader('bytes=40-', 45)).toEqual({ start: 40, end: 44 });
    expect(parseRangeHeader('bytes=0-', 45)).toEqual({ start: 0, end: 44 });
    expect(parseRangeHeader('bytes=-5', 45)).toEqual({ start: 40, end: 44 });
    expect(parseRangeHeader('bytes=-100', 45)).toEqual({ start: 0, end: 44 });
  });

  it('rejects unsatisfiable and malformed ranges', () => {
    expect(parseRangeHeader('bytes=45-', 45)).toBe('unsatisfiable');
    expect(parseRangeHeader('bytes=100-120', 45)).toBe('unsatisfiable');
    expect(parseRangeHeader('bytes=45-', 0)).toBe('unsatisfiable');
    expect(parseRangeHeader(null, 45)).toBe('invalid');
    expect(parseRangeHeader('bytes=-', 45)).toBe('invalid');
    expect(parseRangeHeader('bytes=a-b', 45)).toBe('invalid');
    expect(parseRangeHeader('items=0-1', 45)).toBe('invalid');
    expect(parseRangeHeader('bytes=20-10', 45)).toBe('invalid');
  });
});

describe('partsForRange', () => {
  it('maps a range inside a single part', () => {
    expect(partsForRange(manifest, { start: 0, end: 19 })).toEqual([0]);
    expect(partsForRange(manifest, { start: 5, end: 9 })).toEqual([0]);
    expect(partsForRange(manifest, { start: 40, end: 44 })).toEqual([2]);
  });

  it('maps ranges spanning multiple parts using prefix sums', () => {
    expect(partsForRange(manifest, { start: 18, end: 21 })).toEqual([0, 1]);
    expect(partsForRange(manifest, { start: 0, end: 44 })).toEqual([0, 1, 2]);
    expect(partsForRange(manifest, { start: 19, end: 39 })).toEqual([0, 1]);
    expect(partsForRange(manifest, { start: 39, end: 40 })).toEqual([1, 2]);
  });

  it('handles a smaller trailing part correctly', () => {
    const trailing = { ...manifest, size: 21, parts: [manifest.parts[0], { ...manifest.parts[2], partNo: 1 }] };
    expect(partsForRange(trailing, { start: 20, end: 20 })).toEqual([1]);
    expect(partsForRange(trailing, { start: 0, end: 20 })).toEqual([0, 1]);
  });
});

describe('contentRange', () => {
  it('formats inclusive byte ranges', () => {
    expect(contentRange({ start: 0, end: 44 }, 45)).toBe('bytes 0-44/45');
    expect(contentRange({ start: 40, end: 44 }, 45)).toBe('bytes 40-44/45');
  });
});
