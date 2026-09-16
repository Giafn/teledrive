'use client';

import styles from '../app/page.module.css';

export function formatSize(size: number | null | undefined): string {
  if (size === null || size === undefined) return '—';
  return size > 1024 ** 3
    ? `${(size / 1024 ** 3).toFixed(1)} GB`
    : size > 1024 ** 2
      ? `${(size / 1024 ** 2).toFixed(1)} MB`
      : `${Math.max(1, Math.round(size / 1024))} KB`;
}

export function mimeStyle(mime: string | null | undefined): string {
  const value = mime?.toLowerCase() ?? '';
  if (value.startsWith('image/')) return styles.mimeImage;
  if (value === 'application/pdf') return styles.mimePdf;
  if (value.startsWith('video/')) return styles.mimeVideo;
  return styles.mimeDocument;
}

export function formatDate(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) continue;
    return date.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' });
  }
  return '—';
}
