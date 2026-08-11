'use client';

import { useEffect, useRef, useState } from 'react';
import {
  api,
  ApiError,
  type FolderChildrenResponse,
  type FolderItem,
  type ObjectListItem,
  type TrashItem,
  type StoragePoolResponse,
  type WorkspaceResponse,
  type WorkspaceSummary,
} from '../lib/api';
import {
  createUploadController,
  createUploadQueue,
  type UploadController,
  type UploadProgress,
} from '../lib/upload-controller';
import {
  createDownloadController,
  isPreviewMimeSupported,
  type DownloadProgress,
  DownloadError,
} from '../lib/download-controller';
import styles from './page.module.css';
import {
  logoutAfterSuccess,
  permanentlyDeleteTrashItem,
  requestTelegramAuthorization,
  restoreTrashItem,
  trashActionAvailability,
} from '../lib/ui-actions';

type View = 'drive' | 'recent' | 'trash' | 'settings';
type Upload = {
  id: string;
  file: File;
  controller: UploadController;
  progress?: UploadProgress;
  error?: string;
};
type DownloadItem = { id: string; name: string; mime: string; size: number | null };
type DownloadAction = {
  controller: ReturnType<typeof createDownloadController>;
  name: string;
  progress?: DownloadProgress;
  error?: string;
  done?: boolean;
};
type SelectedEntry = { id: string; kind: 'folder' | 'object'; name: string; parentId?: string };

const iconPaths: Record<string, React.ReactNode> = {
  drive: (
    <>
      <path d="m7 3 5 0 7 12H5L2 10" />
      <path d="M5 15 2.5 19h15L15 15" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  trash: (
    <>
      <path d="M4 7h16M9 7V4h6v3m-9 0 1 13h10l1-13M10 11v5m4-5v5" />
    </>
  ),
  settings: (
    <>
      <path d="M12 3v2m0 14v2M3 12h2m14 0h2M5.6 5.6 7 7m10 10 1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4" />
      <circle cx="12" cy="12" r="3.5" />
    </>
  ),
  search: (
    <>
      <circle cx="10.8" cy="10.8" r="6.8" />
      <path d="m16 16 4 4" />
    </>
  ),
  plus: (
    <>
      <path d="M12 5v14M5 12h14" />
    </>
  ),
  upload: (
    <>
      <path d="M12 16V4m0 0L7 9m5-5 5 5M5 19h14" />
    </>
  ),
  grid: (
    <>
      <rect x="4" y="4" width="6" height="6" />
      <rect x="14" y="4" width="6" height="6" />
      <rect x="4" y="14" width="6" height="6" />
      <rect x="14" y="14" width="6" height="6" />
    </>
  ),
  list: (
    <>
      <path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" />
    </>
  ),
  chevron: <path d="m9 6 6 6-6 6" />,
  folder: (
    <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H10l2 2h7.5A1.5 1.5 0 0 1 21 8.5v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 16.5z" />
  ),
  more: (
    <>
      <circle cx="5" cy="12" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
    </>
  ),
  close: (
    <>
      <path d="m6 6 12 12M18 6 6 18" />
    </>
  ),
  pause: (
    <>
      <path d="M8 5v14M16 5v14" />
    </>
  ),
  play: <path d="m8 5 11 7-11 7z" />,
  check: <path d="m5 12 4 4L19 6" />,
  restore: (
    <>
      <path d="M4 12a8 8 0 1 0 2-5.3" />
      <path d="M4 5v5h5" />
    </>
  ),
  download: (
    <>
      <path d="M12 4v11m0 0 5-5m-5 5-5-5M4 20h16" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5m0-8v.01" />
    </>
  ),
  spark: <path d="m12 2 1.8 7.2L21 11l-7.2 1.8L12 20l-1.8-7.2L3 11l7.2-1.8z" />,
};
function Icon({ name, size = 18 }: { name: string; size?: number }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {iconPaths[name]}
    </svg>
  );
}
function message(error: unknown) {
  const bounded = (value: unknown) =>
    typeof value === 'string' && value.length > 0 && value.length <= 2048 ? value : '';
  if (error instanceof Error) return bounded(error.message) || 'Terjadi kesalahan. Coba lagi.';
  if (typeof error === 'string') return bounded(error) || 'Terjadi kesalahan. Coba lagi.';
  if (error && typeof error === 'object') {
    const record = error as { message?: unknown; text?: unknown };
    return bounded(record.message) || bounded(record.text) || 'Terjadi kesalahan. Coba lagi.';
  }
  return 'Terjadi kesalahan. Coba lagi.';
}
function controllerError(error: unknown) {
  const text = message(error);
  const code = error instanceof ApiError ? error.code : text.match(/\bBOT_[A-Z_]+\b/)?.[0];
  if (code === 'BOT_NOT_CONFIGURED' || code === 'BOT_CHANNEL_MISSING' || code === 'BOT_CHANNEL_NOT_BOUND')
    return 'Bot atau channel belum siap. Buka Pengaturan untuk menyelesaikan setup.';
  if (code === 'BOT_CHALLENGE_EXPIRED') return 'Kode setup kedaluwarsa. Buka Pengaturan untuk menghubungkan ulang bot.';
  if (code === 'BOT_TOKEN_INVALID') return 'Token bot tidak valid. Periksa token BotFather lalu coba lagi.';
  if (code === 'BOT_PART_ATTEMPT_IN_PROGRESS')
    return 'Bagian file masih diproses Worker. Jangan abandon attempt; tunggu sebentar lalu lanjutkan attempt.';
  if (code === 'BOT_PART_ATTEMPT_AMBIGUOUS')
    return 'Status bagian file tidak dapat dipastikan. Abandon attempt, lalu coba lagi.';
  return text || 'Permintaan upload gagal. Coba lagi.';
}
function downloadError(error: unknown) {
  if (error instanceof DownloadError) {
    const guidance: Record<string, string> = {
      TG_AUTH_REQUIRED: 'Bot belum terhubung. Buka Pengaturan untuk melanjutkan.',
      CHANNEL_MISSING: 'Channel privat belum terhubung. Buka Pengaturan untuk melanjutkan.',
      DOWNLOAD_TOO_LARGE: 'File terlalu besar untuk fallback browser ini.',
      STREAMSAVER_UNAVAILABLE:
        'Browser tidak mendukung unduhan besar langsung. Gunakan Chrome atau Edge terbaru melalui HTTPS.',
      PREVIEW_UNSUPPORTED_MIME: 'Tipe file ini hanya dapat diunduh.',
      PREVIEW_TOO_LARGE: 'Preview dibatasi hingga 200 MiB.',
      DOWNLOAD_ABORTED: 'Unduhan dibatalkan.',
      TG_PART_DOWNLOAD_FAILED: 'Satu bagian file gagal setelah dicoba ulang. Coba lagi.',
    };
    return guidance[error.code] ?? 'Unduhan gagal. Coba lagi.';
  }
  return controllerError(error);
}
function formatSize(size: number | null) {
  if (size === null) return '—';
  return size > 1000 ** 3
    ? `${(size / 1000 ** 3).toFixed(1)} GB`
    : size > 1000 ** 2
      ? `${(size / 1000 ** 2).toFixed(1)} MB`
      : `${Math.max(1, Math.round(size / 1000))} KB`;
}
function mimeStyle(mime: string | null) {
  const value = mime?.toLowerCase() ?? '';
  if (value.startsWith('image/')) return styles.mimeImage;
  if (value === 'application/pdf') return styles.mimePdf;
  if (value.startsWith('video/')) return styles.mimeVideo;
  return styles.mimeDocument;
}
function formatDate(...values: unknown[]) {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) continue;
    return date.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' });
  }
  return '—';
}

export default function Page() {
  const [user, setUser] = useState<{ id: string; displayName: string; username: string } | null>(null);
  const [sessionReady, setSessionReady] = useState(false);
  const [sessionRestoreError, setSessionRestoreError] = useState('');
  const [telegramBusy, setTelegramBusy] = useState(false);
  const [telegramError, setTelegramError] = useState('');
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [workspace, setWorkspace] = useState<WorkspaceResponse | null>(null);
  const [folder, setFolder] = useState<FolderChildrenResponse | null>(null);
  const [recent, setRecent] = useState<ObjectListItem[]>([]);
  const [trash, setTrash] = useState<TrashItem[]>([]);
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [logoutError, setLogoutError] = useState('');
  const [specialCursor, setSpecialCursor] = useState<string | null>(null);
  const [specialLoading, setSpecialLoading] = useState(false);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Record<string, SelectedEntry>>({});
  const [moveSelection, setMoveSelection] = useState<SelectedEntry[]>([]);
  const [moveDialog, setMoveDialog] = useState(false);
  const [mutationError, setMutationError] = useState('');
  const [crumbs, setCrumbs] = useState<{ id: string; name: string }[]>([]);
  const [view, setView] = useState<View>('drive');
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [query, setQuery] = useState('');
  const [layout, setLayout] = useState<'list' | 'grid'>('list');
  const [pool, setPool] = useState<StoragePoolResponse | null>(null);
  const [poolError, setPoolError] = useState('');
  const poolReady = pool?.ready === true;
  const [sort, setSort] = useState('Terakhir diubah');
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [downloads, setDownloads] = useState<Record<string, DownloadAction>>({});
  const [preview, setPreview] = useState<DownloadItem | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [folderDialog, setFolderDialog] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const settings = useRef({ chunkSize: 16 * 1024 * 1024 });
  const uploadQueue = useRef(createUploadQueue());
  useEffect(() => {
    setMenuId(null);
    setSelected({});
  }, [view]);
  useEffect(() => {
    if (!menuId) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuId(null);
    };
    const closeOutside = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || !target.closest('[data-file-menu]')) setMenuId(null);
    };
    document.addEventListener('keydown', closeOnEscape);
    document.addEventListener('pointerdown', closeOutside);
    return () => {
      document.removeEventListener('keydown', closeOnEscape);
      document.removeEventListener('pointerdown', closeOutside);
    };
  }, [menuId]);
  function startDownload(item: DownloadItem) {
    const controller = createDownloadController({
      onProgress: (progress) =>
        setDownloads((current) => ({ ...current, [item.id]: { ...current[item.id], controller, progress } })),
    });
    setDownloads((current) => ({ ...current, [item.id]: { controller, name: item.name } }));
    controller
      .save(item.id, { name: item.name, size: item.size ?? 0 })
      .then(() =>
        setDownloads((current) => ({ ...current, [item.id]: { ...current[item.id], controller, done: true } })),
      )
      .catch((error) =>
        setDownloads((current) => ({
          ...current,
          [item.id]: { ...current[item.id], controller, error: downloadError(error) },
        })),
      );
  }

  async function loadFolder(id: string, nextCrumbs = crumbs) {
    setLoading(true);
    setLoadError('');
    try {
      const result = await api.listFolderChildren(id, { limit: 100 });
      setFolder(result);
      setCrumbs(nextCrumbs);
    } catch (error) {
      setLoadError(message(error));
    } finally {
      setLoading(false);
    }
  }
  async function enterApp(authUser: { id: string; displayName: string; username: string }, workspaceId?: string) {
    setUser(authUser);
    void probePool();
    setLoading(true);
    setLoadError('');
    try {
      const result = await api.getWorkspace(workspaceId);
      setWorkspace(result);
      setWorkspaces((current) => current.some((item) => item.id === result.workspace.id) ? current : [...current, result.workspace]);
      setCrumbs([{ id: result.rootFolder.id, name: result.rootFolder.name }]);
      setFolder(await api.listFolderChildren(result.rootFolder.id, { limit: 100 }));
    } catch (error) {
      setLoadError(message(error));
    } finally {
      setLoading(false);
    }
  }
  async function probePool() {
    setPoolError('');
    try {
      setPool(await api.getStoragePool());
    } catch (error) {
      setPool(null);
      setPoolError(message(error));
    }
  }
  async function openTelegram(mode: 'login' | 'register', secretInfo?: string) {
    if (telegramBusy) return;
    setTelegramBusy(true);
    setTelegramError('');
    try {
      window.location.assign(
        await requestTelegramAuthorization(api, mode, secretInfo),
      );
    } catch (error) {
      setTelegramError(message(error));
      setTelegramBusy(false);
    }
  }
  async function restoreSession() {
    setSessionRestoreError('');
    setSessionReady(false);
    try {
      const current = await api.getCurrentSession();
      if (current) {
        const available = await api.listWorkspaces();
        setWorkspaces(available.workspaces);
        await enterApp(current, available.workspaces[0]?.id);
      }
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 401)) setSessionRestoreError(message(error));
    } finally {
      setSessionReady(true);
    }
  }
  useEffect(() => {
    void restoreSession();
  }, []);
  useEffect(() => {
    const knownErrors: Record<string, string> = {
      telegram_denied: 'Login Telegram dibatalkan.',
      telegram_failed: 'Login Telegram gagal. Coba lagi.',
    };
    const code = new URLSearchParams(window.location.search).get('error');
    if (code && knownErrors[code]) setTelegramError(knownErrors[code]);
  }, []);
  async function loadSpecial(nextView: 'recent' | 'trash', append = false) {
    setView(nextView);
    setSpecialLoading(true);
    setLoadError('');
    try {
      const result =
        nextView === 'recent'
          ? await api.listRecent({ limit: 50, ...(append && specialCursor ? { cursor: specialCursor } : {}) })
          : await api.listTrash({ limit: 50, ...(append && specialCursor ? { cursor: specialCursor } : {}) });
      if (nextView === 'recent') setRecent([...(append ? recent : []), ...(result.items as ObjectListItem[])]);
      else setTrash([...(append ? trash : []), ...(result.items as TrashItem[])]);
      setSpecialCursor(result.nextCursor);
    } catch (error) {
      setLoadError(message(error));
    } finally {
      setSpecialLoading(false);
    }
  }
  async function mutate(
    kind: 'folder' | 'object',
    action: 'rename' | 'move' | 'delete' | 'restore' | 'purge',
    id: string,
    currentName?: string,
    trashItem?: TrashItem,
  ) {
    setMutationError('');
    setMenuId(null);
    try {
      if (action === 'rename' || action === 'move') {
        if (kind === 'folder') {
          if (action === 'move') {
            setMoveSelection([{ id, kind, name: currentName ?? 'Folder', parentId: folder?.folder.id }]);
            setMoveDialog(true);
            return;
          }
          setMutationError('Folder belum memiliki endpoint rename atau move.');
          return;
        }
        if (action === 'rename') {
          const name = window.prompt('Nama baru', currentName ?? '');
          if (!name?.trim()) return;
          await api.updateObject(id, { name: name.trim() });
        } else {
          setMoveSelection([{ id, kind, name: currentName ?? 'File', parentId: folder?.folder.id }]);
          setMoveDialog(true);
          return;
        }
      } else if (kind === 'folder') {
        if (action === 'delete') await api.softDeleteFolder(id);
        if (action === 'restore') await (trashItem ? restoreTrashItem(api, trashItem) : api.restoreFolder(id));
        if (action === 'purge') {
          if (!window.confirm('Hapus folder permanen dari metadata? Blob channel tidak ikut dihapus.')) return;
          await (trashItem ? permanentlyDeleteTrashItem(api, trashItem) : api.permanentDeleteFolder(id));
        }
      } else {
        if (action === 'delete') await api.softDeleteObject(id);
        if (action === 'restore') await (trashItem ? restoreTrashItem(api, trashItem) : api.restoreObject(id));
        if (action === 'purge') {
          if (!window.confirm('Hapus file permanen dari metadata? Blob channel tidak ikut dihapus.')) return;
          await (trashItem ? permanentlyDeleteTrashItem(api, trashItem) : api.permanentDeleteObject(id));
        }
      }
      if (view === 'drive' && workspace) await loadFolder(folder?.folder.id ?? workspace.rootFolder.id);
      else await loadSpecial(view === 'trash' ? 'trash' : 'recent');
    } catch (error) {
      setMutationError(message(error));
    }
  }
  function toggleSelection(entry: SelectedEntry) {
    setSelected((current) => {
      const next = { ...current };
      if (next[entry.id]) delete next[entry.id];
      else next[entry.id] = entry;
      return next;
    });
  }
  function openMove(entries = Object.values(selected)) {
    if (!entries.length) return;
    setMenuId(null);
    setMoveSelection(entries);
    setMoveDialog(true);
  }
  async function refreshCurrent() {
    if (view === 'drive' && workspace) await loadFolder(folder?.folder.id ?? workspace.rootFolder.id);
    else if (view === 'recent') await loadSpecial('recent');
  }
  async function bulkTrash() {
    const entries = Object.values(selected);
    if (!entries.length) return;
    setSelected({});
    const failures: string[] = [];
    for (const entry of entries) {
      try {
        if (entry.kind === 'folder') await api.softDeleteFolder(entry.id);
        else await api.softDeleteObject(entry.id);
      } catch {
        failures.push(entry.name);
      }
    }
    await refreshCurrent();
    setMutationError(
      failures.length ? `${failures.length} item gagal dipindahkan ke sampah: ${failures.join(', ')}` : '',
    );
  }
  async function completeMove(destinationId: string) {
    const entries = moveSelection;
    const failures: string[] = [];
    for (const entry of entries) {
      if (entry.kind === 'folder' && (entry.id === destinationId || entry.parentId === destinationId)) {
        failures.push(`${entry.name} (tujuan tidak valid)`);
        continue;
      }
      try {
        if (entry.kind === 'folder') await api.updateFolder(entry.id, { parentId: destinationId });
        else await api.updateObject(entry.id, { folderId: destinationId });
      } catch {
        failures.push(entry.name);
      }
    }
    setMoveDialog(false);
    setMoveSelection([]);
    setSelected({});
    await refreshCurrent();
    setMutationError(
      failures.length ? `${entries.length - failures.length} berhasil dipindahkan. Gagal: ${failures.join(', ')}` : '',
    );
  }
  function uploadFiles(files: FileList | File[]) {
    if (!workspace || !poolReady) return;
    Array.from(files).forEach((file) => {
      const id = crypto.randomUUID();
      let controller: UploadController;
      controller = createUploadController({
        file,
        folderId: folder?.folder.id ?? workspace.rootFolder.id,
        chunkSize: settings.current.chunkSize,
        concurrency: 1,
        onProgress: (progress) =>
          setUploads((items) => items.map((item) => (item.id === id ? { ...item, progress } : item))),
      } as Parameters<typeof createUploadController>[0]);
      const item = { id, file, controller };
      setUploads((items) => [item, ...items]);
      setDrawer(true);
      uploadQueue.current
        .enqueue(() => controller.start())
        .then(() => loadFolder(folder?.folder.id ?? workspace.rootFolder.id))
        .catch((error) => {
          if (error?.name !== 'UploadCancelledError')
            setUploads((items) => items.map((x) => (x.id === id ? { ...x, error: controllerError(error) } : x)));
        });
    });
  }
  async function retryUpload(item: Upload) {
    const blocked = item.progress?.error?.attemptStatus;
    if (blocked) {
      try {
        if (
          blocked === 'ambiguous' &&
          !window.confirm(
            'Abandon attempt dan coba lagi? Telegram mungkin sudah menerima bagian file ini, sehingga orphan atau duplikat bisa tertinggal.',
          )
        )
          return;
        if (blocked === 'ambiguous') await item.controller.abandonPartAttempt(item.progress?.blockedPartNo);
        setUploads((xs) => xs.map((x) => (x.id === item.id ? { ...x, error: undefined } : x)));
        uploadQueue.current
          .enqueue(() => item.controller.resumeSameUpload())
          .then(() => loadFolder(folder?.folder.id ?? workspace!.rootFolder.id))
          .catch((error) =>
            setUploads((xs) => xs.map((x) => (x.id === item.id ? { ...x, error: controllerError(error) } : x))),
          );
      } catch (error) {
        setUploads((xs) => xs.map((x) => (x.id === item.id ? { ...x, error: controllerError(error) } : x)));
      }
      return;
    }
    const controller = createUploadController({
      file: item.file,
      folderId: folder?.folder.id ?? workspace?.rootFolder.id,
      chunkSize: settings.current.chunkSize,
      concurrency: 1,
      onProgress: (progress) =>
        setUploads((xs) => xs.map((x) => (x.id === item.id ? { ...x, controller, progress, error: undefined } : x))),
    } as Parameters<typeof createUploadController>[0]);
    setUploads((xs) => xs.map((x) => (x.id === item.id ? { ...x, controller, error: undefined } : x)));
    uploadQueue.current
      .enqueue(() => controller.start())
      .then(() => loadFolder(folder?.folder.id ?? workspace!.rootFolder.id))
      .catch((error) =>
        setUploads((xs) => xs.map((x) => (x.id === item.id ? { ...x, error: controllerError(error) } : x))),
      );
  }
  async function createFolder(name: string) {
    if (!name.trim() || !workspace) return;
    try {
      await api.createFolder(name.trim(), folder?.folder.id ?? workspace.rootFolder.id);
      setFolderDialog(false);
      await loadFolder(folder?.folder.id ?? workspace.rootFolder.id);
    } catch (error) {
      setLoadError(message(error));
    }
  }
  async function logout() {
    if (logoutBusy) return;
    setLogoutBusy(true);
    setLogoutError('');
    await logoutAfterSuccess(
      api,
      () => {
        setUser(null);
        setWorkspace(null);
        setFolder(null);
      },
      () => setLogoutError(''),
      (error) => setLogoutError(message(error)),
    );
    setLogoutBusy(false);
  }

  if (!sessionReady) return <SessionRestore />;
  if (sessionRestoreError && !user) return <SessionRestore error={sessionRestoreError} onRetry={restoreSession} />;
  if (!user) return <AuthScreen telegramBusy={telegramBusy} telegramError={telegramError} onTelegram={openTelegram} />;
  const items = (folder?.items ?? [])
    .filter((item) => item.name.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) =>
      sort === 'Nama A–Z'
        ? a.name.localeCompare(b.name)
        : sort === 'Ukuran terbesar'
          ? (b.size ?? 0) - (a.size ?? 0)
          : b.createdAt.localeCompare(a.createdAt),
    );
  const active = uploads.filter((item) => item.progress?.phase !== 'completed' && item.progress?.phase !== 'cancelled');
  return (
    <main className={styles.app}>
      <aside className={styles.sidebar}>
        <div className={styles.brand}>
          <span className={styles.logo}>
            <Icon name="spark" size={17} />
          </span>
          ruang<span className={styles.dot}>.</span>
        </div>
        <button className={styles.uploadButton} disabled={!poolReady} onClick={() => fileInput.current?.click()}>
          <Icon name="upload" /> Unggah file
        </button>
        <nav aria-label="Navigasi utama" className={styles.nav}>
          <NavItem
            icon="drive"
            label="Drive saya"
            active={view === 'drive'}
            onClick={() => {
              setView('drive');
              if (workspace) loadFolder(folder?.folder.id ?? workspace.rootFolder.id);
            }}
          />
          <NavItem icon="clock" label="Terbaru" active={view === 'recent'} onClick={() => loadSpecial('recent')} />
          <NavItem icon="trash" label="Sampah" active={view === 'trash'} onClick={() => loadSpecial('trash')} />
        </nav>
        <div className={styles.sideBottom}>
          <div className={styles.storageLabel}>
            <span>Penyimpanan</span>
            <b>{poolReady ? 'Pool siap' : 'Memeriksa…'}</b>
          </div>
          <div className={styles.storageBar}>
            <i />
          </div>
          <button className={styles.settingsLink} onClick={() => setView('settings')}>
            <Icon name="settings" /> Pengaturan
          </button>
          <div className={styles.profile}>
            <span className={styles.avatar}>{user.displayName.slice(0, 2).toUpperCase()}</span>
            <span>
              <b>{user.displayName}</b>
              <small>{user.username}</small>
            </span>
          </div>
        </div>
      </aside>
      <section className={styles.content}>
        <header className={styles.header}>
          <button className={styles.mobileBrand}>
            <span className={styles.logo}>
              <Icon name="spark" size={15} />
            </span>
            ruang<span className={styles.dot}>.</span>
          </button>
          <label className={styles.search}>
            <Icon name="search" />
            <input
              aria-label="Cari file"
              placeholder="Cari file atau folder"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <kbd>⌘ K</kbd>
          </label>
          <div className={styles.headerActions}>
            <span className={styles.connected}>
              <span className={styles.onlineDot} /> API aktif
            </span>
            <button className={styles.avatar} aria-label="Buka profil">
              {user.displayName.slice(0, 2).toUpperCase()}
            </button>
          </div>
        </header>
        {Object.keys(selected).length > 0 && view !== 'trash' && view !== 'settings' && (
          <SelectionToolbar
            count={Object.keys(selected).length}
            onMove={() => openMove()}
            onTrash={bulkTrash}
            onClear={() => setSelected({})}
          />
        )}
        {view === 'settings' ? (
          <Settings
            settings={settings}
            pool={pool}
            poolError={poolError}
            onRefreshPool={probePool}
            onLogout={logout}
            logoutBusy={logoutBusy}
            logoutError={logoutError}
            workspace={workspace}
            userId={user.id}
            workspaces={workspaces}
            onWorkspaceChange={(id) => void enterApp(user, id)}
          />
        ) : view !== 'drive' ? (
          <SpecialView
            title={view === 'recent' ? 'Terbaru' : 'Sampah'}
            items={view === 'recent' ? recent : trash}
            loading={specialLoading}
            error={loadError}
            cursor={specialCursor}
            onLoadMore={() => loadSpecial(view as 'recent' | 'trash', true)}
            onRetry={() => loadSpecial(view as 'recent' | 'trash')}
            onMutate={mutate}
            menuId={menuId}
            setMenuId={setMenuId}
            mutationError={mutationError}
            onDownload={startDownload}
            downloads={downloads}
            onPreview={setPreview}
            selected={selected}
            onToggleSelection={toggleSelection}
            onMove={openMove}
          />
        ) : (
          <>
            <div className={styles.pageTop}>
              <div>
                <div className={styles.eyebrow}>
                  RUANG PRIBADI <span>•</span> {workspace?.workspace.name ?? 'MEMUAT'}
                </div>
                <h1>{folder?.folder.name ?? 'Drive saya'}</h1>
                <div className={styles.breadcrumb}>
                  {crumbs.map((crumb, i) => (
                    <span className={styles.breadcrumbItem} key={crumb.id}>
                      {i > 0 && <Icon name="chevron" size={14} />}
                      <button onClick={() => loadFolder(crumb.id, crumbs.slice(0, i + 1))}>{crumb.name}</button>
                    </span>
                  ))}
                </div>
              </div>
              <div className={styles.topActions}>
                <button className={styles.secondaryButton} onClick={() => setFolderDialog(true)}>
                  <Icon name="plus" size={16} /> Folder baru
                </button>
                <button
                  className={styles.primaryButton}
                  disabled={!poolReady}
                  onClick={() => fileInput.current?.click()}
                >
                  <Icon name="upload" size={16} /> Unggah
                </button>
              </div>
            </div>
            {!poolReady && (
              <div className={styles.notice} role="status">
                Storage pool belum siap. Periksa Pengaturan untuk informasi status.
              </div>
            )}
            <div className={styles.toolbar}>
              <span className={styles.itemCount}>{loading ? 'Memuat…' : `${items.length} item`}</span>
              <div className={styles.toolbarRight}>
                <select aria-label="Urutkan file" value={sort} onChange={(e) => setSort(e.target.value)}>
                  <option>Terakhir diubah</option>
                  <option>Nama A–Z</option>
                  <option>Ukuran terbesar</option>
                </select>
                <div className={styles.segmented}>
                  <button
                    className={layout === 'list' ? styles.selected : ''}
                    onClick={() => setLayout('list')}
                    aria-label="Tampilan daftar"
                  >
                    <Icon name="list" size={17} />
                  </button>
                  <button
                    className={layout === 'grid' ? styles.selected : ''}
                    onClick={() => setLayout('grid')}
                    aria-label="Tampilan grid"
                  >
                    <Icon name="grid" size={17} />
                  </button>
                </div>
              </div>
            </div>
            {loadError && (
              <ErrorState
                error={loadError}
                onRetry={() => workspace && loadFolder(folder?.folder.id ?? workspace.rootFolder.id)}
              />
            )}{' '}
            {!loading && !loadError && (
              <div className={`${styles.fileArea} ${layout === 'grid' ? styles.grid : ''}`}>
                {items.map((item) => (
                  <FileRow
                    key={item.id}
                    item={item}
                    onOpen={() =>
                      item.kind === 'folder'
                        ? loadFolder(item.id, [...crumbs, { id: item.id, name: item.name }])
                        : setPreview({
                            id: item.id,
                            name: item.name,
                            mime: item.mime ?? 'application/octet-stream',
                            size: item.size,
                          })
                    }
                    onMutate={mutate}
                    onDownload={startDownload}
                    download={downloads[item.id]}
                    menuId={menuId}
                    setMenuId={setMenuId}
                    selected={selected}
                    onToggleSelection={toggleSelection}
                    onMove={openMove}
                  />
                ))}
                {!items.length && <Empty query={query} />}
              </div>
            )}
          </>
        )}
      </section>
      <nav className={styles.bottomNav} aria-label="Navigasi utama">
        <NavItem
          icon="drive"
          label="Drive"
          active={view === 'drive'}
          onClick={() => {
            setView('drive');
            if (workspace) loadFolder(folder?.folder.id ?? workspace.rootFolder.id);
          }}
        />
        <NavItem icon="clock" label="Terbaru" active={view === 'recent'} onClick={() => loadSpecial('recent')} />
        <NavItem icon="trash" label="Sampah" active={view === 'trash'} onClick={() => loadSpecial('trash')} />
        <NavItem icon="settings" label="Pengaturan" active={view === 'settings'} onClick={() => setView('settings')} />
      </nav>
      <input
        ref={fileInput}
        hidden
        type="file"
        multiple
        onChange={(e) => {
          if (e.target.files) uploadFiles(e.target.files);
          e.target.value = '';
        }}
      />
      {active.length > 0 && (
        <button className={styles.uploadPill} onClick={() => setDrawer(true)}>
          <span className={styles.pulse} />
          <span>
            <b>{active.length} upload aktif</b>
            <small>
              {active[0].progress?.phase === 'hashing' ? 'Menghitung SHA-256' : 'Mengunggah ke channel privat'}
            </small>
          </span>
          <Icon name="chevron" size={16} />
        </button>
      )}
      {drawer && (
        <UploadDrawer
          uploads={uploads}
          onClose={() => {
            setDrawer(false);
            setUploads((items) => items.filter((item) => item.progress?.phase !== 'completed' && !item.error));
          }}
          onRetry={retryUpload}
        />
      )}{' '}
      {folderDialog && <FolderDialog onClose={() => setFolderDialog(false)} onCreate={createFolder} />}{' '}
      {preview && (
        <PreviewModal
          item={preview}
          onClose={() => setPreview(null)}
          onDownload={startDownload}
          download={downloads[preview.id]}
        />
      )}
      {moveDialog && workspace && (
        <MoveDialog
          workspace={workspace}
          selected={moveSelection}
          onClose={() => {
            setMoveDialog(false);
            setMoveSelection([]);
          }}
          onConfirm={completeMove}
        />
      )}
      <DownloadToasts
        downloads={downloads}
        onDismiss={(id) =>
          setDownloads((current) => {
            const next = { ...current };
            delete next[id];
            return next;
          })
        }
      />
    </main>
  );
}

function SessionRestore({ error, onRetry }: { error?: string; onRetry?: () => void }) {
  return (
    <main className={styles.authPage}>
      <div className={styles.authCard} role={error ? 'alert' : undefined}>
        <div className={styles.brand}>
          <span className={styles.logo}>
            <Icon name="spark" size={17} />
          </span>
          ruang<span className={styles.dot}>.</span>
        </div>
        <div className={styles.eyebrow}>RUANG PRIBADI</div>
        <h1>{error ? 'Sesi belum dapat dipulihkan.' : 'Memulihkan sesi…'}</h1>
        <p className={styles.authIntro}>
          {error
            ? 'Periksa koneksi lalu coba lagi. Login tidak ditampilkan sebelum pemeriksaan sesi selesai.'
            : 'Memeriksa sesi aman dan memuat ruang kerja kamu.'}
        </p>
        {error && (
          <>
            <div className={styles.formError}>
              <Icon name="info" size={16} />
              {message(error)}
            </div>
            <button className={styles.primaryButton} onClick={onRetry}>
              Coba pulihkan lagi
            </button>
          </>
        )}
      </div>
    </main>
  );
}
function SelectionToolbar({
  count,
  onMove,
  onTrash,
  onClear,
}: {
  count: number;
  onMove: () => void;
  onTrash: () => void;
  onClear: () => void;
}) {
  return (
    <div className={styles.selectionToolbar} role="toolbar" aria-label="Aksi item terpilih">
      <b>{count} dipilih</b>
      <button onClick={onMove}>Pindahkan ke</button>
      <button onClick={onTrash}>Pindahkan ke sampah</button>
      <button className={styles.selectionClear} onClick={onClear} aria-label="Batalkan pilihan">
        <Icon name="close" size={16} />
      </button>
    </div>
  );
}

function MoveDialog({
  workspace,
  selected,
  onClose,
  onConfirm,
}: {
  workspace: WorkspaceResponse;
  selected: SelectedEntry[];
  onClose: () => void;
  onConfirm: (id: string) => Promise<void>;
}) {
  const [path, setPath] = useState([{ id: workspace.rootFolder.id, name: workspace.rootFolder.name }]);
  const [children, setChildren] = useState<FolderItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const destination = path[path.length - 1];
  const blocked = new Set(selected.filter((item) => item.kind === 'folder').map((item) => item.id));
  async function loadFolders(folderId: string, nextPath: { id: string; name: string }[]) {
    setLoading(true);
    setError('');
    try {
      const result = await api.listFolderChildren(folderId, { limit: 100 });
      setChildren(result.items.filter((item) => item.kind === 'folder'));
      setPath(nextPath);
    } catch (reason) {
      setError(message(reason));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void loadFolders(workspace.rootFolder.id, path);
  }, []);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [onClose]);
  const invalid = blocked.has(destination.id);
  return (
    <div className={styles.modalBackdrop} onMouseDown={onClose}>
      <section
        className={styles.moveDialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="move-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className={styles.moveHeader}>
          <div>
            <span className={styles.eyebrow}>PINDAHKAN ITEM</span>
            <h2 id="move-title">Pindahkan ke</h2>
          </div>
          <button className={styles.dialogClose} onClick={onClose} aria-label="Tutup">
            <Icon name="close" />
          </button>
        </header>
        <div className={styles.moveSummary}>{selected.length} item dipilih</div>
        <div className={styles.movePath} aria-label="Lokasi tujuan">
          {path.map((item, index) => (
            <span key={item.id}>
              {index > 0 && <Icon name="chevron" size={13} />}
              <button onClick={() => loadFolders(item.id, path.slice(0, index + 1))}>{item.name}</button>
            </span>
          ))}
        </div>
        {error && (
          <div className={styles.formError} role="alert">
            <Icon name="info" size={16} />
            {error}
          </div>
        )}
        <div className={styles.folderPicker} aria-live="polite">
          {loading ? (
            <div className={styles.loadingState}>Memuat folder…</div>
          ) : children.length ? (
            children.map((item) => (
              <button
                className={styles.folderChoice}
                key={item.id}
                disabled={blocked.has(item.id)}
                onClick={() => loadFolders(item.id, [...path, { id: item.id, name: item.name }])}
              >
                <Icon name="folder" size={18} />
                <span>{item.name}</span>
                <Icon name="chevron" size={15} />
              </button>
            ))
          ) : (
            <div className={styles.folderEmpty}>Tidak ada subfolder di lokasi ini.</div>
          )}
        </div>
        <p className={styles.moveHint}>
          {invalid
            ? 'Folder tidak dapat dipindahkan ke dirinya sendiri atau turunannya.'
            : `Tujuan: ${destination.name}`}
        </p>
        <footer className={styles.dialogActions}>
          <button className={styles.secondaryButton} onClick={onClose}>
            Batal
          </button>
          <button
            className={styles.primaryButton}
            disabled={loading || saving || invalid}
            onClick={async () => {
              setSaving(true);
              await onConfirm(destination.id);
              setSaving(false);
            }}
          >
            {saving ? 'Memindahkan…' : 'Pindahkan ke sini'}
          </button>
        </footer>
      </section>
    </div>
  );
}

function AuthScreen({
  onTelegram,
  telegramBusy,
  telegramError,
}: {
  onTelegram: (mode: 'login' | 'register', secretInfo?: string) => Promise<void>;
  telegramBusy: boolean;
  telegramError: string;
}) {
  const [register, setRegister] = useState(false);
  const secretInfoRef = useRef<HTMLInputElement>(null);
  const [secretInfoValid, setSecretInfoValid] = useState(false);
  async function submitTelegram() {
    const input = secretInfoRef.current;
    if (register) {
      if (!input?.checkValidity()) {
        input?.reportValidity();
        return;
      }
      const value = input.value;
      input.value = '';
      setSecretInfoValid(false);
      await onTelegram('register', value);
      return;
    }
    await onTelegram('login');
  }
  return (
    <main className={styles.authPage}>
      <div className={styles.authCard}>
        <div className={styles.brand}>
          <span className={styles.logo}>
            <Icon name="spark" size={17} />
          </span>
          ruang<span className={styles.dot}>.</span>
        </div>
        <div className={styles.eyebrow}>DRIVE PRIBADI</div>
        <h1>{register ? 'Mulai ruangmu.' : 'Selamat datang kembali.'}</h1>
        <p className={styles.authIntro}>
          {register ? 'Buat akun baru dengan Telegram.' : 'Masuk ke ruang pribadimu dengan Telegram.'}
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submitTelegram();
          }}
        >
          {register && (
            <label className={styles.field}>
              Secret info <span className={styles.fieldHint}>wajib</span>
              <input
                autoFocus
                id="secret-info"
                name="secret-info"
                ref={secretInfoRef}
                type="password"
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                required
                onInput={() => setSecretInfoValid(secretInfoRef.current?.checkValidity() ?? false)}
                placeholder="Masukkan secret info"
              />
            </label>
          )}
          <button className={styles.telegramButton} type="submit" disabled={telegramBusy || (register && !secretInfoValid)}>
            {telegramBusy ? 'Membuka Telegram…' : register ? 'Daftar dengan Telegram' : 'Masuk dengan Telegram'}
          </button>
        </form>
        {telegramError && (
          <div className={styles.formError} role="alert">
            {telegramError}
          </div>
        )}
        <p className={styles.authSwitch}>
          {register ? 'Sudah punya akun?' : 'Belum punya akun?'}{' '}
          <button
            onClick={() => {
              setRegister(!register);
              if (secretInfoRef.current) secretInfoRef.current.value = '';
              setSecretInfoValid(false);
            }}
          >
            {register ? 'Masuk' : 'Daftar'}
          </button>
        </p>
        <small className={styles.secureNote}>Telegram mengautentikasi akun Ruang. Ruang tidak meminta nomor, OTP, atau 2FA.</small>
      </div>
    </main>
  );
}
function NavItem({
  icon,
  label,
  active,
  onClick,
}: {
  icon: string;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button className={`${styles.navItem} ${active ? styles.navActive : ''}`} onClick={onClick}>
      <Icon name={icon} />
      <span>{label}</span>
    </button>
  );
}
function FileRow({
  item,
  onOpen,
  onMutate,
  menuId,
  setMenuId,
  onDownload,
  download,
  selected,
  onToggleSelection,
  onMove,
}: {
  item: FolderItem;
  onOpen: () => void;
  onMutate: (
    kind: 'folder' | 'object',
    action: 'rename' | 'move' | 'delete' | 'restore' | 'purge',
    id: string,
    name?: string,
    trashItem?: TrashItem,
  ) => void;
  menuId: string | null;
  setMenuId: (id: string | null) => void;
  onDownload: (item: DownloadItem) => void;
  download?: DownloadAction;
  selected: Record<string, SelectedEntry>;
  onToggleSelection: (entry: SelectedEntry) => void;
  onMove: (entries?: SelectedEntry[]) => void;
}) {
  const folder = item.kind === 'folder';
  const downloadable = { id: item.id, name: item.name, mime: item.mime ?? 'application/octet-stream', size: item.size };
  return (
    <article
      className={styles.fileRow}
      onDoubleClick={onOpen}
      tabIndex={folder ? 0 : undefined}
      onKeyDown={(e) => folder && e.key === 'Enter' && onOpen()}
    >
      <input
        className={styles.selectionCheckbox}
        type="checkbox"
        checked={Boolean(selected[item.id])}
        onChange={() => onToggleSelection({ id: item.id, kind: folder ? 'folder' : 'object', name: item.name })}
        onClick={(event) => event.stopPropagation()}
        aria-label={`Pilih ${item.name}`}
      />
      <span className={`${styles.fileIcon} ${folder ? styles.folderIcon : mimeStyle(item.mime)}`}>
        {folder ? (
          <Icon name="folder" size={20} />
        ) : (
          <b>{item.mime?.split('/')[1]?.slice(0, 4).toUpperCase() ?? 'FILE'}</b>
        )}
      </span>
      <button className={styles.fileName} onClick={onOpen}>
        <b>{item.name}</b>
        <small>{folder ? 'Folder' : `${formatSize(item.size)} · ${item.status ?? 'tersimpan'}`}</small>
      </button>
      <span className={styles.fileDate}>
        {new Date(item.createdAt).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' })}
      </span>
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
            {!folder && (
              <>
                <button
                  role="menuitem"
                  onClick={() => {
                    setMenuId(null);
                    onDownload(downloadable);
                  }}
                >
                  {download?.error
                    ? 'Coba lagi'
                    : download?.done
                      ? 'Selesai'
                      : download?.progress?.totalBytes
                        ? `Unduh ${Math.round((download.progress.bytesDownloaded / download.progress.totalBytes) * 100)}%`
                        : 'Unduh file'}
                </button>
                {download?.error && <small className={styles.downloadError}>{download.error}</small>}
              </>
            )}
            <button
              role="menuitem"
              onClick={() => onMutate(folder ? 'folder' : 'object', 'rename', item.id, item.name)}
            >
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
              onClick={() => onMutate(folder ? 'folder' : 'object', 'delete', item.id, item.name)}
            >
              Pindahkan ke sampah
            </button>
          </div>
        )}
      </span>
    </article>
  );
}
function PreviewModal({
  item,
  onClose,
  onDownload,
  download,
}: {
  item: DownloadItem;
  onClose: () => void;
  onDownload: (item: DownloadItem) => void;
  download?: DownloadAction;
}) {
  const [progress, setProgress] = useState<DownloadProgress>();
  const [preview, setPreview] = useState<{ url: string; mime: string; revoke: () => void }>();
  const [error, setError] = useState('');
  const urlRef = useRef<{ revoke: () => void }>();
  const tooLarge = (item.size ?? 0) > 200 * 1024 * 1024;
  const supported = isPreviewMimeSupported(item.mime) && !tooLarge;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    if (supported) {
      const abort = new AbortController();
      const controller = createDownloadController({ signal: abort.signal, onProgress: setProgress });
      controller
        .loadPreview(item.id, abort.signal)
        .then((result) => {
          urlRef.current = result;
          setPreview(result);
        })
        .catch((reason) => {
          if (reason?.code !== 'DOWNLOAD_ABORTED') setError(downloadError(reason));
        });
      return () => {
        abort.abort();
        urlRef.current?.revoke();
        window.removeEventListener('keydown', onKey);
      };
    }
    return () => window.removeEventListener('keydown', onKey);
  }, [item.id, supported]);
  const percent = progress?.totalBytes ? Math.round((progress.bytesDownloaded / progress.totalBytes) * 100) : 0;
  return (
    <div className={styles.previewBackdrop} role="presentation" onMouseDown={onClose}>
      <section
        className={styles.previewModal}
        role="dialog"
        aria-modal="true"
        aria-labelledby="preview-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className={styles.previewHeader}>
          <div>
            <span className={styles.eyebrow}>PRATINJAU FILE</span>
            <h2 id="preview-title" title={item.name}>
              {item.name}
            </h2>
          </div>
          <button className={styles.dialogClose} onClick={onClose} aria-label="Tutup pratinjau">
            <Icon name="close" />
          </button>
        </header>
        <div className={styles.previewBody}>
          {!supported ? (
            <div className={styles.previewNotice}>
              <span className={styles.emptyArt}>
                <Icon name="download" size={25} />
              </span>
              <h3>{tooLarge ? 'File terlalu besar untuk pratinjau' : 'Pratinjau belum tersedia'}</h3>
              <p>
                {tooLarge
                  ? 'Pratinjau dibatasi hingga 200 MiB agar perangkat tetap responsif.'
                  : 'Tipe file ini tidak memiliki tampilan browser yang aman.'}
              </p>
              <DownloadButton item={item} action={download} onDownload={onDownload} />
            </div>
          ) : error ? (
            <div className={styles.previewNotice}>
              <span className={styles.emptyArt}>
                <Icon name="info" size={25} />
              </span>
              <h3>Pratinjau gagal</h3>
              <p>{error}</p>
              <div className={styles.flowButtons}>
                <button className={styles.secondaryButton} onClick={onClose}>
                  Tutup
                </button>
                <DownloadButton item={item} action={download} onDownload={onDownload} />
              </div>
            </div>
          ) : !preview ? (
            <div className={styles.previewLoading} aria-live="polite">
              <span className={styles.spinner} />
              <b>Menyiapkan pratinjau…</b>
              <small>{percent}%</small>
              <button className={styles.textButton} onClick={onClose}>
                Batalkan
              </button>
            </div>
          ) : item.mime.startsWith('image/') ? (
            <img className={styles.previewImage} src={preview.url} alt={item.name} />
          ) : item.mime === 'application/pdf' ? (
            <iframe className={styles.previewFrame} src={preview.url} title={`Pratinjau ${item.name}`} />
          ) : (
            <video className={styles.previewVideo} src={preview.url} controls preload="metadata" />
          )}
        </div>
        <footer className={styles.previewFooter}>
          <span>
            {formatSize(item.size)} · {item.mime}
          </span>
          <DownloadButton item={item} action={download} onDownload={onDownload} />
        </footer>
      </section>
    </div>
  );
}
function DownloadButton({
  item,
  action,
  onDownload,
}: {
  item: DownloadItem;
  action?: DownloadAction;
  onDownload: (item: DownloadItem) => void;
}) {
  const percent = action?.progress?.totalBytes
    ? Math.round((action.progress.bytesDownloaded / action.progress.totalBytes) * 100)
    : 0;
  return (
    <span className={styles.downloadAction}>
      <button
        className={styles.downloadButton}
        onClick={(event) => {
          event.stopPropagation();
          onDownload(item);
        }}
        disabled={Boolean(action && !action.error && !action.done)}
        aria-label={`Unduh ${item.name}`}
      >
        {action?.error ? 'Coba lagi' : action?.done ? 'Selesai' : action?.progress ? `Unduh ${percent}%` : 'Unduh'}
      </button>
      {action?.error && <small className={styles.downloadError}>{action.error}</small>}
    </span>
  );
}
function DownloadToasts({
  downloads,
  onDismiss,
}: {
  downloads: Record<string, DownloadAction>;
  onDismiss: (id: string) => void;
}) {
  const entries = Object.entries(downloads).filter(([, action]) => action.progress || action.error || action.done);
  if (!entries.length) return null;
  return (
    <div className={styles.downloadToasts} role="region" aria-label="Unduhan">
      {entries.map(([id, action]) => {
        const percent = action.progress?.totalBytes
          ? Math.round((action.progress.bytesDownloaded / action.progress.totalBytes) * 100)
          : 0;
        return (
          <div
            key={id}
            className={`${styles.downloadToast} ${action.error ? styles.downloadToastError : ''} ${action.done ? styles.downloadToastDone : ''}`}
          >
            <div className={styles.downloadToastTitle}>
              <b title={action.name}>{action.name}</b>
              <button
                className={styles.downloadToastClose}
                onClick={() => onDismiss(id)}
                aria-label={`Tutup unduhan ${action.name}`}
              >
                <Icon name="close" size={14} />
              </button>
            </div>
            {action.error ? (
              <small>{action.error}</small>
            ) : action.done ? (
              <small>Selesai</small>
            ) : (
              <>
                <div className={styles.downloadToastBar}>
                  <i style={{ width: `${percent}%` }} />
                </div>
                <small>Sedang mendownload… {percent}%</small>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
function Empty({ query }: { query: string }) {
  return (
    <div className={styles.empty}>
      <span className={styles.emptyArt}>
        <Icon name={query ? 'search' : 'folder'} size={30} />
      </span>
      <h2>{query ? 'File tidak ditemukan' : 'Folder masih kosong'}</h2>
      <p>{query ? 'Coba kata kunci lain.' : 'Unggah file atau buat folder baru untuk mulai.'}</p>
    </div>
  );
}
function ErrorState({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <div className={styles.errorState} role="alert">
      <Icon name="info" />
      <div>
        <b>Drive tidak dapat dimuat</b>
        <p>{error}</p>
        <button className={styles.textButton} onClick={onRetry}>
          Coba lagi
        </button>
      </div>
    </div>
  );
}
function Unavailable({ title }: { title: string }) {
  return (
    <div className={styles.unavailable}>
      <span className={styles.emptyArt}>
        <Icon name={title === 'Sampah' ? 'trash' : 'clock'} size={30} />
      </span>
      <h1>{title}</h1>
      <h2>Belum tersedia di API</h2>
      <p>Endpoint untuk {title.toLowerCase()} belum tersedia. Ruang tidak menampilkan data palsu.</p>
    </div>
  );
}
function SpecialView({
  title,
  items,
  loading,
  error,
  cursor,
  onLoadMore,
  onRetry,
  onMutate,
  menuId,
  setMenuId,
  mutationError,
  onDownload,
  downloads,
  onPreview,
  selected,
  onToggleSelection,
  onMove,
}: {
  title: string;
  items: (ObjectListItem | TrashItem)[];
  loading: boolean;
  error: string;
  cursor: string | null;
  onLoadMore: () => void;
  onRetry: () => void;
  onMutate: (
    kind: 'folder' | 'object',
    action: 'rename' | 'move' | 'delete' | 'restore' | 'purge',
    id: string,
    name?: string,
    trashItem?: TrashItem,
  ) => void;
  menuId: string | null;
  setMenuId: (id: string | null) => void;
  mutationError: string;
  onDownload: (item: DownloadItem) => void;
  downloads: Record<string, DownloadAction>;
  onPreview: (item: DownloadItem) => void;
  selected: Record<string, SelectedEntry>;
  onToggleSelection: (entry: SelectedEntry) => void;
  onMove: (entries?: SelectedEntry[]) => void;
}) {
  const trashView = title === 'Sampah';
  return (
    <>
      <div className={styles.pageTop}>
        <div>
          <div className={styles.eyebrow}>
            RUANG PRIBADI <span>•</span> SERVER METADATA
          </div>
          <h1>{title}</h1>
          <p className={styles.subtle}>
            {trashView
              ? 'Item dihapus dari Drive. Retensi dan status berasal dari server.'
              : 'File yang baru diubah atau diunggah.'}
          </p>
        </div>
      </div>
      {mutationError && (
        <div className={styles.errorState} role="alert">
          <Icon name="info" />
          <span>{mutationError}</span>
        </div>
      )}
      {error && <ErrorState error={error} onRetry={onRetry} />}{' '}
      {!error && (
        <div className={styles.fileArea}>
          {loading && (
            <div className={styles.loadingState} aria-live="polite">
              Memuat data server…
            </div>
          )}
          {!loading &&
            items.map((item) => (
              <ObjectRow
                key={item.id}
                item={item}
                trash={trashView}
                onMutate={onMutate}
                menuId={menuId}
                setMenuId={setMenuId}
                onDownload={onDownload}
                download={downloads[item.id]}
                onPreview={onPreview}
                selected={selected}
                onToggleSelection={onToggleSelection}
                onMove={onMove}
              />
            ))}
          {!loading && !items.length && <Empty query="" />}
          {!loading && cursor && (
            <button className={styles.loadMore} onClick={onLoadMore}>
              Muat lebih banyak
            </button>
          )}
        </div>
      )}
    </>
  );
}
function ObjectRow({
  item,
  trash,
  onMutate,
  menuId,
  setMenuId,
  onDownload,
  download,
  onPreview,
  selected,
  onToggleSelection,
  onMove,
}: {
  item: ObjectListItem | TrashItem;
  trash: boolean;
  onMutate: (
    kind: 'folder' | 'object',
    action: 'rename' | 'move' | 'delete' | 'restore' | 'purge',
    id: string,
    name?: string,
    trashItem?: TrashItem,
  ) => void;
  menuId: string | null;
  setMenuId: (id: string | null) => void;
  onDownload: (item: DownloadItem) => void;
  download?: DownloadAction;
  onPreview: (item: DownloadItem) => void;
  selected: Record<string, SelectedEntry>;
  onToggleSelection: (entry: SelectedEntry) => void;
  onMove: (entries?: SelectedEntry[]) => void;
}) {
  const folder = trash && 'type' in item && item.type === 'folder';
  const trashItem = item as TrashItem;
  const object = item as ObjectListItem | Extract<TrashItem, { type: 'object' }>;
  const downloadable = !folder
    ? { id: object.id, name: object.name, mime: object.mime ?? 'application/octet-stream', size: object.size }
    : null;
  const deletedAt = trash && 'deletedAt' in item ? item.deletedAt : undefined;
  return (
    <article className={styles.fileRow}>
      {!trash && (
        <input
          className={styles.selectionCheckbox}
          type="checkbox"
          checked={Boolean(selected[item.id])}
          onChange={() => onToggleSelection({ id: item.id, kind: folder ? 'folder' : 'object', name: item.name })}
          aria-label={`Pilih ${item.name}`}
        />
      )}
      <span className={`${styles.fileIcon} ${folder ? styles.folderIcon : mimeStyle(object.mime)}`}>
        {folder ? <Icon name="folder" size={18} /> : <b>{object.mime?.split('/')[1]?.slice(0, 4).toUpperCase() || 'FILE'}</b>}
      </span>
      <button className={styles.fileName} disabled={folder} onClick={() => downloadable && onPreview(downloadable)}>
        <b>{item.name}</b>
        <small>
          {folder ? 'Folder' : formatSize(object.size)} · {deletedAt ? 'Dihapus ' + new Date(deletedAt).toLocaleDateString('id-ID') : 'File'}
        </small>
      </button>
      <span className={styles.fileDate}>
        {formatDate(...(trash ? [deletedAt, item.updatedAt, item.createdAt] : [item.updatedAt, item.createdAt]))}
      </span>
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
            {trash ? (
              <>
                <button role="menuitem" onClick={() => onMutate(folder ? 'folder' : 'object', 'restore', item.id, item.name, trashItem)}>
                  Pulihkan
                </button>
                {trashActionAvailability(trashItem).permanentlyDelete && <button
                  role="menuitem"
                  className={styles.dangerAction}
                  onClick={() => onMutate(folder ? 'folder' : 'object', 'purge', item.id, item.name, trashItem)}
                >
                  Hapus metadata permanen
                </button>}
                {!trashActionAvailability(trashItem).permanentlyDelete && (
                  <small className={styles.downloadError}>Penghapusan permanen tidak tersedia untuk akun ini.</small>
                )}
              </>
            ) : (
              <>
                <button
                  role="menuitem"
                  onClick={() => {
                    setMenuId(null);
                    if (downloadable) onDownload(downloadable);
                  }}
                >
                  {download?.error
                    ? 'Coba lagi'
                    : download?.done
                      ? 'Selesai'
                      : download?.progress?.totalBytes
                        ? `Unduh ${Math.round((download.progress.bytesDownloaded / download.progress.totalBytes) * 100)}%`
                        : 'Unduh file'}
                </button>
                {download?.error && <small className={styles.downloadError}>{download.error}</small>}
                <button role="menuitem" onClick={() => onMutate('object', 'rename', item.id, item.name)}>
                  Ganti nama
                </button>
                <button role="menuitem" onClick={() => onMove([{ id: item.id, kind: 'object', name: item.name }])}>
                  Pindahkan ke
                </button>
                <button
                  role="menuitem"
                  className={styles.dangerAction}
                  onClick={() => onMutate('object', 'delete', item.id, item.name)}
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
}
function FolderDialog({ onClose, onCreate }: { onClose: () => void; onCreate: (name: string) => void }) {
  const [name, setName] = useState('');
  return (
    <div className={styles.modalBackdrop} onMouseDown={onClose}>
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="folder-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <button className={styles.dialogClose} onClick={onClose} aria-label="Tutup">
          <Icon name="close" />
        </button>
        <span className={styles.dialogIcon}>
          <Icon name="folder" />
        </span>
        <h2 id="folder-title">Folder baru</h2>
        <p>Folder akan dibuat di lokasi yang sedang dibuka.</p>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && onCreate(name)}
          placeholder="Contoh: Proyek 2026"
        />
        <div className={styles.dialogActions}>
          <button className={styles.secondaryButton} onClick={onClose}>
            Batal
          </button>
          <button className={styles.primaryButton} onClick={() => onCreate(name)}>
            Buat folder
          </button>
        </div>
      </div>
    </div>
  );
}
function UploadDrawer({
  uploads,
  onClose,
  onRetry,
}: {
  uploads: Upload[];
  onClose: () => void;
  onRetry: (item: Upload) => void;
}) {
  return (
    <aside className={styles.drawer} aria-label="Antrean upload">
      <div className={styles.drawerHead}>
        <div>
          <b>Antrean upload</b>
          <small>{uploads.length} file · antrean Bot</small>
        </div>
        <button onClick={onClose} aria-label="Tutup antrean">
          <Icon name="close" />
        </button>
      </div>
      <div className={styles.uploadList}>
        {uploads.map((item) => {
          const progress = item.progress;
          const percent = progress?.totalBytes ? Math.round((progress.bytesUploaded / progress.totalBytes) * 100) : 0;
          const paused = progress?.phase === 'paused';
          const done = progress?.phase === 'completed';
          return (
            <div className={styles.uploadItem} key={item.id}>
              <span className={styles.fileIcon}>
                <b>{item.file.name.split('.').pop()?.slice(0, 4).toUpperCase() ?? 'FILE'}</b>
              </span>
              <div className={styles.uploadInfo}>
                <b title={item.file.name}>{item.file.name}</b>
                <div className={styles.miniMeta}>
                  <span>{formatSize(item.file.size)}</span>
                  <span>
                    {item.error
                      ? 'Gagal'
                      : done
                        ? 'Selesai'
                        : progress?.phase === 'hashing'
                          ? 'Menghitung hash'
                          : paused
                            ? 'Dijeda'
                            : 'Mengunggah'}
                  </span>
                </div>
                <div className={styles.miniProgress}>
                  <i style={{ width: `${percent}%` }} />
                </div>
                <small>
                  {progress
                    ? `${progress.phase === 'hashing' ? 'Menghitung hash' : 'Sedang mengunggah'} · ${percent}%`
                    : 'Menunggu mulai'}
                </small>
                {item.error && <small className={styles.uploadError}>{controllerError(item.error)}</small>}
              </div>
              {item.error ? (
                <button className={styles.retryButton} onClick={() => onRetry(item)}>
                  {item.progress?.error?.attemptStatus === 'ambiguous'
                    ? 'Abandon attempt dan coba lagi'
                    : item.progress?.error?.attemptStatus === 'in_progress'
                      ? 'Lanjutkan attempt'
                      : 'Coba lagi'}
                </button>
              ) : done ? (
                <Icon name="check" size={17} />
              ) : (
                <div className={styles.uploadControls}>
                  <button
                    aria-label={paused ? 'Lanjutkan upload' : 'Jeda upload'}
                    onClick={() => (paused ? item.controller.resume() : item.controller.pause())}
                  >
                    <Icon name={paused ? 'play' : 'pause'} size={15} />
                  </button>
                  <button aria-label={`Batalkan ${item.file.name}`} onClick={() => item.controller.cancel()}>
                    <Icon name="close" size={15} />
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className={styles.drawerFoot}>
        <Icon name="info" size={16} /> Pause menghentikan pembacaan bagian baru. Browser mobile dapat menjeda app di
        latar.
      </div>
    </aside>
  );
}

function Settings({
  settings,
  pool,
  poolError,
  onRefreshPool,
  onLogout,
  logoutBusy,
  logoutError,
  workspace,
  userId,
  workspaces,
  onWorkspaceChange,
}: {
  settings: React.MutableRefObject<{ chunkSize: number }>;
  pool: StoragePoolResponse | null;
  poolError: string;
  onRefreshPool: () => Promise<void>;
  onLogout: () => Promise<void>;
  logoutBusy: boolean;
  logoutError: string;
  workspace: WorkspaceResponse | null;
  userId: string;
  workspaces: WorkspaceSummary[];
  onWorkspaceChange: (id: string) => void;
}) {
  const [error, setError] = useState('');
  const [memberId, setMemberId] = useState('');
  const [memberBusy, setMemberBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [probing, setProbing] = useState(true);
  useEffect(() => {
    setProbing(true);
    onRefreshPool().finally(() => setProbing(false));
  }, []);
  async function exportData() {
    setError('');
    try {
      const data = await api.exportWorkspace(workspace?.workspace.id);
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `ruang-export-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(message(e));
    }
  }
  async function addMember() {
    if (!workspace || !memberId.trim()) return;
    setMemberBusy(true); setError('');
    try {
      await api.addWorkspaceMember(workspace.workspace.id, memberId.trim());
      setMemberId('');
      await onWorkspaceChange(workspace.workspace.id);
    } catch (e) { setError(message(e)); } finally { setMemberBusy(false); }
  }
  async function removeMember(id: string) {
    if (!workspace || !window.confirm('Hapus anggota ini dari workspace?')) return;
    setMemberBusy(true); setError('');
    try { await api.removeWorkspaceMember(workspace.workspace.id, id); await onWorkspaceChange(workspace.workspace.id); }
    catch (e) { setError(message(e)); } finally { setMemberBusy(false); }
  }
  return (
    <div className={styles.settings}>
      <div className={styles.eyebrow}>PREFERENSI</div>
      <h1>Pengaturan</h1>
      <p className={styles.subtle}>Koneksi, upload, dan data lokal perangkat ini.</p>
      <section className={styles.settingsCard}>
        <div className={styles.settingTitle}><div><h2>Workspace</h2><p>Pilih ruang yang dapat kamu akses.</p></div></div>
        <select aria-label="Pilih workspace" value={workspace?.workspace.id ?? ''} onChange={(e) => onWorkspaceChange(e.target.value)}>
          {workspaces.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.isOwner ? 'Owner' : 'Member'}</option>)}
        </select>
        {workspace && <p className={styles.disclaimer}>{workspace.workspace.isOwner ? 'Kamu owner dan dapat mengelola anggota.' : 'Kamu member · konten bersama dapat dibaca dan dikelola sesuai akses workspace.'}</p>}
      </section>
      <section className={styles.settingsCard}>
        <div className={styles.settingTitle}>
          <span className={styles.telegramMark}>✦</span>
          <div>
            <h2>Penyimpanan</h2>
            <p>
              {probing
                ? 'Memeriksa status…'
                : poolError
                  ? poolError
                  : pool
                    ? `${pool.channel} · ${pool.botCount} bot`
                    : 'Informasi pool tidak tersedia'}
            </p>
          </div>
          <span className={styles.statusTag}>
            {probing
              ? 'Memeriksa'
              : poolError
                ? 'Gagal'
                : pool?.ready
                  ? 'Siap'
                  : pool
                    ? 'Belum siap'
                    : 'Tidak diketahui'}
          </span>
        </div>
        <div className={styles.settingLine}>
          <span>
            <b>Channel</b>
            <small>{pool?.channel ?? '—'}</small>
          </span>
        </div>
        <div className={styles.settingLine}>
          <span>
            <b>Jumlah bot</b>
            <small>{pool ? `${pool.botCount} bot aktif` : '—'}</small>
          </span>
        </div>
        <div className={styles.settingLine}>
          <span>
            <b>Diagnostik</b>
            <small>{pool?.reason ? `${pool.reason.code}: ${pool.reason.message}` : poolError || '—'}</small>
          </span>
        </div>
        <div className={styles.flowButtons}>
          <button className={styles.secondaryButton} onClick={() => void onRefreshPool()}>
            Refresh status
          </button>
        </div>
        {error && (
          <div className={styles.formError} role="alert">
            <Icon name="info" size={16} />
            {error}
          </div>
        )}
        <p className={styles.disclaimer}>
          Bot dikelola oleh administrator. Storage pool menyediakan upload dan download otomatis untuk semua pengguna.
        </p>
      </section>
      {workspace && <section className={styles.settingsCard}>
        <div className={styles.settingTitle}><div><h2>Anggota</h2><p>Workspace ID pengguna Teledrive tidak berubah.</p></div><span className={styles.statusTag}>{workspace.workspace.isOwner ? 'Owner' : 'Read-only'}</span></div>
        <div className={styles.memberId}><code>{userId}</code><button className={styles.textButton} onClick={() => { void navigator.clipboard?.writeText(userId); setCopied(true); setTimeout(() => setCopied(false), 1600); }}>{copied ? 'Tersalin' : 'Salin ID'}</button></div>
        {workspace.workspace.isOwner && <form className={styles.memberAdd} onSubmit={(e) => { e.preventDefault(); void addMember(); }}><input aria-label="ID pengguna anggota" value={memberId} onChange={(e) => setMemberId(e.target.value)} placeholder="Tempel ID pengguna" /><button className={styles.primaryButton} disabled={memberBusy || !memberId.trim()}>{memberBusy ? 'Menambahkan…' : 'Tambah anggota'}</button></form>}
        <div className={styles.memberList} aria-live="polite">
          {workspace.workspace.members.length ? workspace.workspace.members.map((member) => <div className={styles.memberRow} key={member.userId}><span><code>{member.userId}</code><small>{member.role === 'owner' ? 'Owner' : 'Member'}</small></span>{workspace.workspace.isOwner && member.role === 'member' && <button className={styles.textButton} disabled={memberBusy} onClick={() => void removeMember(member.userId)}>Hapus</button>}</div>) : <p className={styles.disclaimer}>Belum ada member.</p>}
        </div>
      </section>}
      <section className={styles.settingsCard}>
        <h2>Upload</h2>
        <div className={styles.settingLine}>
          <span>
            <b>Ukuran bagian</b>
            <small>8–19 MiB, memengaruhi resume</small>
          </span>
          <select
            defaultValue="16"
            onChange={(e) => (settings.current.chunkSize = Number(e.target.value) * 1024 * 1024)}
          >
            <option value="8">8 MiB</option>
            <option value="16">16 MiB</option>
            <option value="19">19 MiB</option>
          </select>
        </div>
      </section>
      <section className={styles.settingsCard}>
        <h2>Data</h2>
        <p className={styles.disclaimer}>
          Ekspor manifest untuk recovery metadata. Worker mengalirkan bagian file terbatas, bukan seluruh file
          sekaligus.
        </p>
        <div className={styles.flowButtons}>
          <button className={styles.textButton} onClick={exportData}>
            Ekspor metadata JSON <Icon name="download" size={16} />
          </button>
          {logoutError && <div className={styles.formError} role="alert"><Icon name="info" size={16} />{logoutError}</div>}
          <button className={styles.textButton} disabled={logoutBusy} onClick={() => void onLogout()}>
            {logoutBusy ? 'Keluar…' : 'Keluar dari Ruang'}
          </button>
        </div>
      </section>
    </div>
  );
}
