'use client';

import type { FolderItem, ObjectListItem, ThumbnailReference } from '../lib/api';
import type { DownloadAction, DownloadItem, SelectedEntry } from './types';
import { FileRow } from './file-row';
import { GalleryView } from './gallery-view';
import { ExplorerToolbar, type ExplorerLayout, type ExplorerSort } from './explorer-toolbar';
import { Empty, ErrorState, GridSkeleton, ListSkeleton } from './explorer-states';
import styles from '../app/page.module.css';

export type ExplorerItem = {
  kind: 'folder' | 'object';
  id: string;
  name: string;
  mime: string | null;
  size: number | null;
  status: string | null;
  createdAt: string;
  updatedAt?: string;
  deletedAt?: string | null;
  partCount?: number | null;
  thumbnail?: ThumbnailReference | null;
};

export function fromFolderItem(item: FolderItem): ExplorerItem {
  return { ...item };
}

export function fromObjectItem(item: ObjectListItem): ExplorerItem {
  return {
    kind: item.type === 'folder' ? 'folder' : 'object',
    id: item.id,
    name: item.name,
    mime: item.mime,
    size: item.size,
    status: item.status,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    deletedAt: item.deletedAt,
    partCount: item.partCount,
    thumbnail: item.thumbnail,
  };
}

export type ExplorerMenu =
  | { kind: 'drive' }
  | { kind: 'recent' }
  | { kind: 'trash' };

export type FileExplorerProps = {
  title: React.ReactNode;
  eyebrow?: React.ReactNode;
  subtitle?: React.ReactNode;
  topActions?: React.ReactNode;
  breadcrumb?: React.ReactNode;
  items: ExplorerItem[];
  loading: boolean;
  loadError: string;
  onRetryLoad: () => void;
  layout: ExplorerLayout;
  onLayoutChange: (layout: ExplorerLayout) => void;
  sort: ExplorerSort;
  onSortChange: (sort: ExplorerSort) => void;
  query: string;
  menu: ExplorerMenu;
  menuId: string | null;
  setMenuId: (id: string | null) => void;
  onMutate: (
    kind: 'folder' | 'object',
    action: 'rename' | 'move' | 'delete' | 'restore' | 'purge',
    id: string,
    name?: string,
  ) => void;
  onOpenFolder: (item: ExplorerItem) => void;
  onPreviewFile: (item: DownloadItem) => void;
  onDownload: (item: DownloadItem) => void;
  downloads: Record<string, DownloadAction>;
  selected: Record<string, SelectedEntry>;
  onToggleSelection: (entry: SelectedEntry) => void;
  onMove: (entries?: SelectedEntry[]) => void;
  selectable?: boolean;
  dateField?: 'updated' | 'deleted';
  loadMore?: { cursor: string | null; loading: boolean; onLoad: () => void } | null;
  emptyContext?: 'folder' | 'search' | 'recent' | 'trash';
};

export function applyExplorerQuery(items: ExplorerItem[], query: string, sort: ExplorerSort): ExplorerItem[] {
  const normalized = query.trim().toLowerCase();
  const filtered = normalized ? items.filter((item) => item.name.toLowerCase().includes(normalized)) : [...items];
  filtered.sort((a, b) =>
    sort === 'Nama A–Z'
      ? a.name.localeCompare(b.name)
      : sort === 'Ukuran terbesar'
        ? (b.size ?? 0) - (a.size ?? 0)
        : (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt),
  );
  return filtered;
}

function toDownloadItem(item: ExplorerItem): DownloadItem {
  return {
    id: item.id,
    name: item.name,
    mime: item.mime ?? 'application/octet-stream',
    size: item.size,
    partCount: item.partCount,
    thumbnail: item.thumbnail,
  };
}

export function FileExplorer(props: FileExplorerProps) {
  const {
    title,
    eyebrow,
    subtitle,
    topActions,
    breadcrumb,
    items,
    loading,
    loadError,
    onRetryLoad,
    layout,
    onLayoutChange,
    sort,
    onSortChange,
    query,
    menu,
    menuId,
    setMenuId,
    onMutate,
    onOpenFolder,
    onPreviewFile,
    onDownload,
    downloads,
    selected,
    onToggleSelection,
    onMove,
    selectable = true,
    dateField = 'updated',
    loadMore = null,
    emptyContext = 'folder',
  } = props;
  const visible = applyExplorerQuery(items, query, sort);
  const handleOpen = (item: ExplorerItem) => {
    if (item.kind === 'folder') onOpenFolder(item);
    else onPreviewFile(toDownloadItem(item));
  };
  return (
    <>
      <div className={styles.pageTop}>
        <div>
          {eyebrow}
          <h1>{title}</h1>
          {subtitle}
          {breadcrumb}
        </div>
        {topActions}
      </div>
      <ExplorerToolbar
        count={loading ? null : visible.length}
        sort={sort}
        onSortChange={onSortChange}
        layout={layout}
        onLayoutChange={onLayoutChange}
      />
      {loadError && <ErrorState error={loadError} onRetry={onRetryLoad} />}
      {loading && !loadError && (
        <div className={styles.fileArea}>{layout === 'grid' ? <GridSkeleton /> : <ListSkeleton />}</div>
      )}
      {!loading && !loadError && (
        <div className={styles.fileArea}>
          {layout === 'grid' ? (
            <GalleryView
              items={visible}
              menuId={menuId}
              setMenuId={setMenuId}
              menu={menu}
              onMutate={onMutate}
              onOpen={handleOpen}
              onDownload={onDownload}
              downloads={downloads}
              selected={selected}
              onToggleSelection={onToggleSelection}
              onMove={onMove}
              selectable={selectable}
              dateField={dateField}
            />
          ) : (
            visible.map((item) => (
              <FileRow
                key={item.id}
                item={item}
                menu={menu}
                onOpen={() => handleOpen(item)}
                onMutate={onMutate}
                onDownload={(downloadable) => onDownload(downloadable)}
                download={downloads[item.id]}
                menuId={menuId}
                setMenuId={setMenuId}
                selected={selected}
                onToggleSelection={onToggleSelection}
                onMove={onMove}
                selectable={selectable}
                dateField={dateField}
              />
            ))
          )}
          {!visible.length && <Empty query={query} context={emptyContext} />}
          {loadMore && loadMore.cursor && (
            <button className={styles.loadMore} onClick={loadMore.onLoad} disabled={loadMore.loading}>
              {loadMore.loading ? 'Memuat…' : 'Muat lebih banyak'}
            </button>
          )}
        </div>
      )}
    </>
  );
}
