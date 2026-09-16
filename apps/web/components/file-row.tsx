'use client';

import { Icon } from './icon';
import type { DownloadAction, DownloadItem, SelectedEntry } from './types';
import type { ExplorerItem, ExplorerMenu } from './file-explorer';
import { formatDate, formatSize, mimeStyle } from './format';
import styles from '../app/page.module.css';

export type MutateAction = 'rename' | 'move' | 'delete' | 'restore' | 'purge';

export type RowMenuProps = {
  item: ExplorerItem;
  menu: ExplorerMenu;
  menuId: string | null;
  setMenuId: (id: string | null) => void;
  onMutate: (kind: 'folder' | 'object', action: MutateAction, id: string, name?: string) => void;
  onDownload: (item: DownloadItem) => void;
  download?: DownloadAction;
  onMove: (entries?: SelectedEntry[]) => void;
};

export function downloadLabel(download?: DownloadAction): string {
  if (download?.error) return 'Coba lagi';
  if (download?.done) return 'Selesai';
  if (download?.progress?.totalBytes)
    return `Unduh ${Math.round((download.progress.bytesDownloaded / download.progress.totalBytes) * 100)}%`;
  return 'Unduh file';
}

export function RowMenu({ item, menu, menuId, setMenuId, onMutate, onDownload, download, onMove }: RowMenuProps) {
  const folder = item.kind === 'folder';
  const downloadable: DownloadItem = {
    id: item.id,
    name: item.name,
    mime: item.mime ?? 'application/octet-stream',
    size: item.size,
    partCount: item.partCount,
    thumbnail: item.thumbnail,
  };
  return (
    <span className={styles.rowMenuWrap} data-file-menu>
      <button
        className={styles.rowMenu}
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
                <>
                  <button
                    role="menuitem"
                    onClick={() => {
                      setMenuId(null);
                      onDownload(downloadable);
                    }}
                  >
                    {downloadLabel(download)}
                  </button>
                  {download?.error && <small className={styles.downloadError}>{download.error}</small>}
                </>
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
  );
}

export type FileRowProps = {
  item: ExplorerItem;
  menu: ExplorerMenu;
  onOpen: () => void;
  onMutate: RowMenuProps['onMutate'];
  onDownload: (item: DownloadItem) => void;
  download?: DownloadAction;
  menuId: string | null;
  setMenuId: (id: string | null) => void;
  selected: Record<string, SelectedEntry>;
  onToggleSelection: (entry: SelectedEntry) => void;
  onMove: (entries?: SelectedEntry[]) => void;
  selectable?: boolean;
  dateField?: 'updated' | 'deleted';
};

export function FileRow({
  item,
  menu,
  onOpen,
  onMutate,
  onDownload,
  download,
  menuId,
  setMenuId,
  selected,
  onToggleSelection,
  onMove,
  selectable = true,
  dateField = 'updated',
}: FileRowProps) {
  const folder = item.kind === 'folder';
  const trash = menu.kind === 'trash';
  const dateValue =
    dateField === 'deleted' ? (item.deletedAt ?? item.updatedAt ?? item.createdAt) : (item.updatedAt ?? item.createdAt);
  return (
    <article
      className={[
        styles.fileRow,
        trash ? styles.rowNoSelect : '',
        !trash && selected[item.id] ? styles.rowSelected : '',
      ]
        .filter(Boolean)
        .join(' ')}
      onDoubleClick={trash ? undefined : onOpen}
      tabIndex={folder && !trash ? 0 : undefined}
      onKeyDown={(event) => folder && !trash && event.key === 'Enter' && onOpen()}
    >
      {selectable && !trash && (
        <input
          className={styles.selectionCheckbox}
          type="checkbox"
          checked={Boolean(selected[item.id])}
          onChange={() => onToggleSelection({ id: item.id, kind: folder ? 'folder' : 'object', name: item.name })}
          onClick={(event) => event.stopPropagation()}
          aria-label={`Pilih ${item.name}`}
        />
      )}
      <span className={`${styles.fileIcon} ${folder ? styles.folderIcon : mimeStyle(item.mime)}`}>
        {folder ? (
          <Icon name="folder" size={20} />
        ) : (
          <b>{item.mime?.split('/')[1]?.slice(0, 4).toUpperCase() ?? 'FILE'}</b>
        )}
      </span>
      <button className={styles.fileName} onClick={onOpen}>
        <b>{item.name}</b>
        <small>
          {folder ? (
            'Folder'
          ) : trash && item.deletedAt ? (
            <>
              {formatSize(item.size)} · Dihapus {formatDate(item.deletedAt)}
            </>
          ) : (
            <>
              {formatSize(item.size)} · {item.status ?? 'tersimpan'}
            </>
          )}
        </small>
      </button>
      <span className={styles.fileDate}>{formatDate(dateValue)}</span>
      <RowMenu
        item={item}
        menu={menu}
        menuId={menuId}
        setMenuId={setMenuId}
        onMutate={onMutate}
        onDownload={onDownload}
        download={download}
        onMove={onMove}
      />
    </article>
  );
}
