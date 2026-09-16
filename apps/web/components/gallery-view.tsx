'use client';

import { useEffect, useRef, useState } from 'react';
import { createDownloadController, DownloadError } from '../lib/download-controller';
import { getThumbnail, setThumbnail } from '../lib/thumbnail-cache';
import { blobToDataURL, captureVideoFrameFromUrl, encodeImageFromUrl } from '../lib/media-thumbnail';
import { acquireThumbnailSlot, releaseThumbnailSlot } from '../lib/thumbnail-slots';
import { Icon } from './icon';
import type { DownloadAction, DownloadItem, SelectedEntry } from './types';
import type { ExplorerItem, ExplorerMenu } from './file-explorer';
import type { MutateAction } from './file-row';
import { downloadLabel } from './file-row';
import { formatDate, formatSize } from './format';
import styles from '../app/page.module.css';

export const LEGACY_VIDEO_THUMBNAIL_LIMIT = 100 * 1024 * 1024;

export function legacyThumbnailEligible(item: ExplorerItem): boolean {
  if (!item.mime?.startsWith('image/') && !item.mime?.startsWith('video/')) return false;
  const parts = item.partCount ?? 1;
  return parts <= 1 && (item.size ?? 0) <= LEGACY_VIDEO_THUMBNAIL_LIMIT;
}

export type GalleryViewProps = {
  items: ExplorerItem[];
  menu: ExplorerMenu;
  menuId: string | null;
  setMenuId: (id: string | null) => void;
  onMutate: (kind: 'folder' | 'object', action: MutateAction, id: string, name?: string) => void;
  onOpen: (item: ExplorerItem) => void;
  onDownload: (item: DownloadItem) => void;
  downloads: Record<string, DownloadAction>;
  selected: Record<string, SelectedEntry>;
  onToggleSelection: (entry: SelectedEntry) => void;
  onMove: (entries?: SelectedEntry[]) => void;
  selectable?: boolean;
  dateField?: 'updated' | 'deleted';
};

export function GalleryView({
  items,
  menu,
  menuId,
  setMenuId,
  onMutate,
  onOpen,
  onDownload,
  downloads,
  selected,
  onToggleSelection,
  onMove,
  selectable = true,
  dateField = 'updated',
}: GalleryViewProps) {
  return (
    <div className={styles.galleryGrid}>
      {items.map((item) => {
        const folder = item.kind === 'folder';
        const isSelected = Boolean(selected[item.id]);
        const download = downloads[item.id];
        const downloadable: DownloadItem = {
          id: item.id,
          name: item.name,
          mime: item.mime ?? 'application/octet-stream',
          size: item.size,
          partCount: item.partCount,
          thumbnail: item.thumbnail,
        };
        const dateValue =
          dateField === 'deleted' ? (item.deletedAt ?? item.updatedAt ?? item.createdAt) : (item.updatedAt ?? item.createdAt);
        return (
          <article key={item.id} className={`${styles.galleryCard} ${isSelected ? styles.gallerySelected : ''}`}>
            {selectable && (
              <input
                className={styles.galleryCheck}
                type="checkbox"
                checked={isSelected}
                onChange={() => onToggleSelection({ id: item.id, kind: folder ? 'folder' : 'object', name: item.name })}
                onClick={(event) => event.stopPropagation()}
                aria-label={`Pilih ${item.name}`}
              />
            )}
            <button
              className={styles.galleryOpen}
              onClick={() => onOpen(item)}
              aria-label={folder ? `Buka folder ${item.name}` : `Pratinjau ${item.name}`}
            >
              <div className={styles.galleryThumb}>
                <GalleryThumbnail item={item} />
              </div>
              <span className={styles.galleryMeta}>
                <b title={item.name}>{item.name}</b>
                <small>
                  {folder ? 'Folder' : formatSize(item.size)} · {formatDate(dateValue)}
                </small>
              </span>
            </button>
            <span className={styles.rowMenuWrap} data-file-menu>
              <button
                className={styles.galleryMenu}
                aria-label={`Opsi ${item.name}`}
                aria-expanded={menuId === item.id}
                onClick={() => setMenuId(menuId === item.id ? null : item.id)}
              >
                <Icon name="more" size={18} />
              </button>
              {menuId === item.id && (
                <div className={styles.rowMenuPopup} role="menu">
                  {menu.kind === 'trash' ? (
                    <>
                      <button
                        role="menuitem"
                        onClick={() => onMutate(folder ? 'folder' : 'object', 'restore', item.id, item.name)}
                      >
                        Pulihkan
                      </button>
                      <button
                        role="menuitem"
                        className={styles.dangerAction}
                        onClick={() => onMutate(folder ? 'folder' : 'object', 'purge', item.id, item.name)}
                      >
                        Hapus metadata permanen
                      </button>
                    </>
                  ) : (
                    <>
                      {!folder && (
                        <button
                          role="menuitem"
                          onClick={() => {
                            setMenuId(null);
                            onDownload(downloadable);
                          }}
                        >
                          {downloadLabel(download)}
                        </button>
                      )}
                      <button role="menuitem" onClick={() => onMutate(item.kind, 'rename', item.id, item.name)}>
                        Ganti nama
                      </button>
                      <button
                        role="menuitem"
                        onClick={() => onMove([{ id: item.id, kind: folder ? 'folder' : 'object', name: item.name }])}
                      >
                        Pindahkan ke
                      </button>
                      <button
                        role="menuitem"
                        className={styles.dangerAction}
                        onClick={() => onMutate(item.kind, 'delete', item.id, item.name)}
                      >
                        Pindahkan ke sampah
                      </button>
                    </>
                  )}
                </div>
              )}
            </span>
          </article>
        );
      })}
    </div>
  );
}

export function GalleryThumbnail({ item }: { item: ExplorerItem }) {
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'unsupported' | 'error'>(() =>
    item.kind === 'folder' || item.thumbnail || legacyThumbnailEligible(item) ? 'idle' : 'unsupported',
  );
  const [preview, setPreview] = useState<string>();
  const containerRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (item.kind === 'folder') return;
    const container = containerRef.current;
    if (!container) return;
    const controller = new AbortController();
    let active = true;
    let slotAcquired = false;
    let revokeUrl: (() => void) | undefined;
    const reference = item.thumbnail ?? null;
    const cacheKey = reference
      ? `thumbnail:${item.id}:${reference.sha256}`
      : `thumbnail:${item.id}:${item.updatedAt ?? item.createdAt}`;
    const load = async () => {
      try {
        const cached = await getThumbnail(cacheKey).catch(() => undefined);
        if (!active) return;
        if (cached) {
          setPreview(cached);
          setState('ready');
          return;
        }
        if (!reference && !legacyThumbnailEligible(item)) {
          setState('unsupported');
          return;
        }
        await acquireThumbnailSlot(controller.signal);
        slotAcquired = true;
        if (!active) return;
        setState('loading');
        const downloader = createDownloadController({ signal: controller.signal });
        const result = reference ? await downloader.loadThumbnail(reference) : await downloader.loadPreview(item.id);
        revokeUrl = result.revoke;
        if (!active) return;
        const dataUrl = reference
          ? await blobToDataURL(await (await fetch(result.url, { signal: controller.signal })).blob())
          : item.mime?.startsWith('video/')
            ? await captureVideoFrameFromUrl(result.url)
            : await encodeImageFromUrl(result.url);
        revokeUrl?.();
        revokeUrl = undefined;
        if (!active) return;
        if (!dataUrl) {
          setState('error');
          return;
        }
        await setThumbnail(cacheKey, dataUrl).catch(() => undefined);
        if (!active) return;
        setPreview(dataUrl);
        setState('ready');
      } catch (error) {
        if (active && !(error instanceof DownloadError && error.code === 'DOWNLOAD_ABORTED')) {
          setState('error');
        }
      } finally {
        revokeUrl?.();
        revokeUrl = undefined;
        if (slotAcquired) releaseThumbnailSlot();
      }
    };
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer.disconnect();
          void load();
        }
      },
      { root: null, rootMargin: '300px 0px' },
    );
    observer.observe(container);
    return () => {
      active = false;
      observer.disconnect();
      controller.abort();
      revokeUrl?.();
    };
  }, [item.id, item.kind, item.mime, item.size, item.partCount, item.thumbnail, item.updatedAt, item.createdAt]);
  if (item.kind === 'folder') {
    return (
      <span ref={containerRef} className={styles.thumbFolder}>
        <Icon name="folder" size={30} />
      </span>
    );
  }
  if (state === 'ready' && preview) {
    return (
      <span ref={containerRef} className={styles.thumbContent}>
        <img src={preview} alt="" />
      </span>
    );
  }
  if (state === 'error') {
    return (
      <span ref={containerRef} className={styles.thumbError}>
        <Icon name="info" size={22} />
        <small>Pratinjau gagal</small>
      </span>
    );
  }
  if (state === 'unsupported') {
    const mimeClass =
      item.mime?.toLowerCase().startsWith('image/') ? styles.mimeImage
      : item.mime === 'application/pdf' ? styles.mimePdf
      : item.mime?.toLowerCase().startsWith('video/') ? styles.mimeVideo
      : styles.mimeDocument;
    return (
      <span ref={containerRef} className={`${styles.thumbTile} ${mimeClass}`}>
        {item.mime?.split('/')[1]?.slice(0, 4).toUpperCase() ?? 'FILE'}
      </span>
    );
  }
  return (
    <span ref={containerRef} className={styles.thumbLoading}>
      {state === 'loading' && <span className={styles.thumbSpinner} aria-hidden="true" />}
    </span>
  );
}
