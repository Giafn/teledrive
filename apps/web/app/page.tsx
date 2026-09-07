'use client';

import { useEffect, useRef, useState } from 'react';
import {
  api,
  ApiError,
  type FolderChildrenResponse,
  type FolderItem,
  type ObjectListItem,
  type WorkspaceResponse,
} from '../lib/api';
import { createUploadController, type UploadController, type UploadProgress } from '../lib/upload-controller';
import {
  createDownloadController,
  isPreviewMimeSupported,
  type DownloadProgress,
  DownloadError,
} from '../lib/download-controller';
import { telegramGateway, type TelegramAuthState } from '../lib/telegram-gateway';
import { getThumbnail, setThumbnail } from '../lib/thumbnail-cache';
import styles from './page.module.css';

type View = 'drive' | 'recent' | 'trash' | 'settings';
type Upload = { id: string; file: File; controller: UploadController; progress?: UploadProgress; error?: string };
type DownloadItem = { id: string; name: string; mime: string; size: number | null };
type DownloadAction = {
  controller: ReturnType<typeof createDownloadController>;
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
function telegramError(error: unknown) {
  const text = message(error);
  const lower = text.toLowerCase();
  const code = text
    .match(/\b[A-Z][A-Z0-9_]{2,63}\b/g)
    ?.find((token) => /^(?:TG_|API_|AUTH_|CHANNEL_|FLOOD_|NETWORK_|PHONE_|SESSION_|RPC_)/.test(token));
  const suffix = code ? ` (${code})` : '';
  if (text.includes('TG_AUTH_REQUIRED') || lower.includes('not authorized') || lower.includes('unauthorized'))
    return `Hubungkan akun Telegram sebelum upload${suffix || ' (TG_AUTH_REQUIRED)'}.`;
  if (lower.includes('api_id') || lower.includes('api hash') || lower.includes('configuration'))
    return `Konfigurasi Telegram belum lengkap — periksa API ID dan API hash deployment${suffix}.`;
  if (lower.includes('channel'))
    return `Channel Telegram belum dikonfigurasi atau tidak dapat diakses — periksa username dan izin admin${suffix}.`;
  if (lower.includes('network') || lower.includes('connection') || lower.includes('timeout'))
    return `Koneksi Telegram bermasalah — periksa jaringan lalu coba lagi${suffix}.`;
  return 'Permintaan Telegram gagal — coba lagi.';
}
function downloadError(error: unknown) {
  if (error instanceof DownloadError) {
    const guidance: Record<string, string> = {
      TG_AUTH_REQUIRED: 'Hubungkan akun Telegram sebelum mengunduh.',
      CHANNEL_MISSING: 'Konfigurasi channel Telegram belum tersedia.',
      DOWNLOAD_TOO_LARGE: 'File terlalu besar untuk fallback browser ini.',
      STREAMSAVER_UNAVAILABLE:
        'Browser tidak mendukung unduhan besar langsung. Gunakan Chrome atau Edge terbaru melalui HTTPS.',
      PREVIEW_UNSUPPORTED_MIME: 'Tipe file ini hanya dapat diunduh.',
      PREVIEW_TOO_LARGE: 'Preview dibatasi hingga 200 MiB.',
      DOWNLOAD_ABORTED: 'Unduhan dibatalkan.',
      TG_PART_DOWNLOAD_FAILED: 'Satu bagian file Telegram gagal setelah dicoba ulang. Coba lagi.',
    };
    return guidance[error.code] ?? 'Unduhan gagal. Coba lagi.';
  }
  return telegramError(error);
}
function formatSize(size: number | null) {
  if (size === null) return '—';
  return size > 1024 ** 3
    ? `${(size / 1024 ** 3).toFixed(1)} GB`
    : size > 1024 ** 2
      ? `${(size / 1024 ** 2).toFixed(1)} MB`
      : `${Math.max(1, Math.round(size / 1024))} KB`;
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

async function createThumbnail(file: File): Promise<string | undefined> {
  if (!file.type.startsWith('image/') && !file.type.startsWith('video/')) return undefined;
  const url = URL.createObjectURL(file);
  try {
    if (file.type.startsWith('video/')) {
      const video = document.createElement('video');
      video.src = url;
      video.muted = true;
      await new Promise<void>((resolve, reject) => {
        video.addEventListener('loadeddata', () => resolve(), { once: true });
        video.addEventListener('error', () => reject(new Error('Video thumbnail failed')), { once: true });
      });
      const canvas = document.createElement('canvas');
      const scale = Math.min(1, 320 / video.videoWidth);
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/jpeg', 0.65);
    }
    const image = await createImageBitmap(file);
    const scale = Math.min(1, 320 / image.width);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    canvas.getContext('2d')?.drawImage(image, 0, 0, canvas.width, canvas.height);
    image.close();
    return canvas.toDataURL('image/jpeg', 0.65);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export default function Page() {
  const [user, setUser] = useState<{ displayName: string; username: string } | null>(null);
  const [sessionReady, setSessionReady] = useState(false);
  const [sessionRestoreError, setSessionRestoreError] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState('');
  const [workspace, setWorkspace] = useState<WorkspaceResponse | null>(null);
  const [folder, setFolder] = useState<FolderChildrenResponse | null>(null);
  const [recent, setRecent] = useState<ObjectListItem[]>([]);
  const [trash, setTrash] = useState<ObjectListItem[]>([]);
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
  const [layout, setLayout] = useState<'list' | 'grid'>('grid');
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
  const [sort, setSort] = useState('Terakhir diubah');
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [downloads, setDownloads] = useState<Record<string, DownloadAction>>({});
  const [preview, setPreview] = useState<DownloadItem | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [folderDialog, setFolderDialog] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const settings = useRef({ chunkSize: 16 * 1024 * 1024, concurrency: 3 });
  useEffect(() => {
    if ('serviceWorker' in navigator) void navigator.serviceWorker.register('/sw.js');
  }, []);
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
    setDownloads((current) => ({ ...current, [item.id]: { controller } }));
    controller
      .save(item.id)
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
  async function enterApp(authUser: { displayName: string; username: string }) {
    setUser(authUser);
    setLoading(true);
    setLoadError('');
    try {
      const result = await api.getWorkspace();
      setWorkspace(result);
      setCrumbs([{ id: result.rootFolder.id, name: result.rootFolder.name }]);
      setFolder(await api.listFolderChildren(result.rootFolder.id, { limit: 100 }));
    } catch (error) {
      setLoadError(message(error));
    } finally {
      setLoading(false);
    }
  }
  async function restoreSession() {
    setSessionRestoreError('');
    setSessionReady(false);
    try {
      const current = await api.getCurrentSession();
      if (current) await enterApp(current);
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 401)) setSessionRestoreError(message(error));
    } finally {
      setSessionReady(true);
    }
  }
  useEffect(() => {
    void restoreSession();
  }, []);
  async function purgeTrash() {
    if (!window.confirm('Hapus permanen semua isi Sampah? Tindakan ini tidak dapat dibatalkan.')) return;
    setLoadError('');
    try {
      await api.purgeTrash();
      await loadSpecial('trash');
    } catch (error) {
      setLoadError(message(error));
    }
  }
  async function loadSpecial(nextView: 'recent' | 'trash', append = false) {
    setView(nextView);
    setSpecialLoading(true);
    setLoadError('');
    try {
      const result =
        nextView === 'recent'
          ? await api.listRecent({ limit: 50, ...(append && specialCursor ? { cursor: specialCursor } : {}) })
          : await api.listTrash({ limit: 50, ...(append && specialCursor ? { cursor: specialCursor } : {}) });
      const list = append ? (nextView === 'recent' ? recent : trash) : [];
      if (nextView === 'recent') setRecent([...list, ...result.items]);
      else setTrash([...list, ...result.items]);
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
            const name = window.prompt('Nama folder baru', currentName ?? '');
            if (!name?.trim()) return;
            await api.updateFolder(id, { name: name.trim() });
         } else if (action === 'rename') {
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
        if (action === 'restore') await api.restoreFolder(id);
        if (action === 'purge') {
          if (!window.confirm('Hapus folder permanen dari metadata? Isi Telegram tidak ikut dihapus.')) return;
          await api.permanentDeleteFolder(id);
        }
      } else {
        if (action === 'delete') await api.softDeleteObject(id);
        if (action === 'restore') await api.restoreObject(id);
        if (action === 'purge') {
          if (!window.confirm('Hapus file permanen dari metadata? Isi Telegram tidak ikut dihapus.')) return;
          await api.permanentDeleteObject(id);
        }
      }
       if (view === 'drive' && workspace) await loadFolder(folder?.folder.id ?? workspace.rootFolder.id);
       else if (view === 'recent' || view === 'trash') await loadSpecial(view);
     } catch (error) {
       setMutationError(
         error instanceof ApiError && error.code === 'FOLDER_NOT_EMPTY'
           ? 'Folder tidak dapat dipindahkan ke sampah karena masih berisi file atau subfolder.'
           : message(error),
       );
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
    if (!workspace) return;
    Array.from(files).forEach((file) => {
      const id = crypto.randomUUID();
      let controller: UploadController;
      controller = createUploadController({
        file,
        folderId: folder?.folder.id ?? workspace.rootFolder.id,
        chunkSize: settings.current.chunkSize,
        concurrency: settings.current.concurrency,
        onProgress: (progress) =>
          setUploads((items) => items.map((item) => (item.id === id ? { ...item, progress } : item))),
      });
      const item = { id, file, controller };
      setUploads((items) => [item, ...items]);
      void createThumbnail(file).then((thumbnail) => {
        if (thumbnail) setThumbnails((current) => ({ ...current, [id]: thumbnail }));
      });
      setDrawer(true);
      controller
        .start()
        .then(() => loadFolder(folder?.folder.id ?? workspace.rootFolder.id))
        .catch((error) => {
          if (error?.name !== 'UploadCancelledError')
            setUploads((items) => items.map((x) => (x.id === id ? { ...x, error: message(error) } : x)));
        });
    });
  }
  async function retryUpload(item: Upload) {
    const controller = createUploadController({
      file: item.file,
      folderId: folder?.folder.id ?? workspace?.rootFolder.id,
      chunkSize: settings.current.chunkSize,
      concurrency: settings.current.concurrency,
      onProgress: (progress) =>
        setUploads((xs) => xs.map((x) => (x.id === item.id ? { ...x, controller, progress, error: undefined } : x))),
    });
    setUploads((xs) => xs.map((x) => (x.id === item.id ? { ...x, controller, error: undefined } : x)));
    controller
      .start()
      .then(() => loadFolder(folder?.folder.id ?? workspace!.rootFolder.id))
      .catch((error) => setUploads((xs) => xs.map((x) => (x.id === item.id ? { ...x, error: message(error) } : x))));
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
    await telegramGateway.logout().catch(() => undefined);
    await api.logout().catch(() => undefined);
    setUser(null);
    setWorkspace(null);
    setFolder(null);
  }

  if (!sessionReady) return <SessionRestore />;
  if (sessionRestoreError && !user) return <SessionRestore error={sessionRestoreError} onRetry={restoreSession} />;
  if (!user)
    return (
      <AuthScreen
        busy={authBusy}
        error={authError}
        onBusy={setAuthBusy}
        onError={setAuthError}
        onSuccess={async (nextUser) => {
          await enterApp(nextUser);
          setSessionReady(true);
        }}
      />
    );
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
        <button className={styles.uploadButton} onClick={() => fileInput.current?.click()}>
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
            <b>Unlimited dengan Telegram</b>
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
          <Settings settings={settings} onLogout={logout} />
        ) : view !== 'drive' ? (
          <SpecialView
            title={view === 'recent' ? 'Terbaru' : 'Sampah'}
            items={view === 'recent' ? recent : trash}
            loading={specialLoading}
            error={loadError}
            cursor={specialCursor}
             onLoadMore={() => loadSpecial(view as 'recent' | 'trash', true)}
             onRetry={() => loadSpecial(view as 'recent' | 'trash')}
             onPurgeAll={purgeTrash}
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
                <button className={styles.primaryButton} onClick={() => fileInput.current?.click()}>
                  <Icon name="upload" size={16} /> Unggah
                </button>
              </div>
            </div>
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
                 {layout === 'grid' && (
                     <GalleryView
                     items={items}
                     thumbnails={thumbnails}
                     menuId={menuId}
                     setMenuId={setMenuId}
                     onMutate={mutate}
                     onOpen={(item) =>
                       item.kind === 'folder'
                         ? loadFolder(item.id, [...crumbs, { id: item.id, name: item.name }])
                         : setPreview({ id: item.id, name: item.name, mime: item.mime ?? 'application/octet-stream', size: item.size })
                     }
                   />
                 )}
                 {layout === 'list' && items.map((item) => (
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
              {active[0].progress?.phase === 'hashing' ? 'Menghitung SHA-256' : 'Mengunggah langsung ke Telegram'}
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
      <nav className={styles.mobileNav} aria-label="Navigasi bawah mobile">
        <button
          className={`${styles.mobileNavItem} ${view === 'drive' ? styles.mobileNavActive : ''}`}
          onClick={() => {
            setView('drive');
            if (workspace) loadFolder(folder?.folder.id ?? workspace.rootFolder.id);
          }}
        >
          <Icon name="drive" size={20} />
          <span>Drive</span>
        </button>
        <button
          className={`${styles.mobileNavItem} ${view === 'recent' ? styles.mobileNavActive : ''}`}
          onClick={() => loadSpecial('recent')}
        >
          <Icon name="clock" size={20} />
          <span>Terbaru</span>
        </button>
        <button
          className={`${styles.mobileNavItem} ${view === 'trash' ? styles.mobileNavActive : ''}`}
          onClick={() => loadSpecial('trash')}
        >
          <Icon name="trash" size={20} />
          <span>Sampah</span>
        </button>
        <button
          className={`${styles.mobileNavItem} ${view === 'settings' ? styles.mobileNavActive : ''}`}
          onClick={() => setView('settings')}
        >
          <Icon name="settings" size={20} />
          <span>Pengaturan</span>
        </button>
      </nav>
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
  busy,
  error,
  onBusy,
  onError,
  onSuccess,
}: {
  busy: boolean;
  error: string;
  onBusy: (v: boolean) => void;
  onError: (v: string) => void;
  onSuccess: (u: { displayName: string; username: string }) => void;
}) {
  const [step, setStep] = useState<'phone' | 'code' | 'password'>('phone');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  async function submit() {
    if (!phone.trim() || (step === 'code' && !code.trim()) || (step === 'password' && !password)) return;
    onBusy(true);
    onError('');
    try {
      const authState =
        step === 'phone'
          ? await telegramGateway.sendCode(phone.trim())
          : step === 'code'
            ? await telegramGateway.signIn(code.trim())
            : await telegramGateway.checkPassword(password);
      if (authState.state === 'code_sent') setStep('code');
      else if (authState.state === 'password_required') setStep('password');
      else if (authState.state === 'authorized') {
        const session = await telegramGateway.checkSession();
        if (!session.user) throw new Error('Sesi Telegram tidak ditemukan.');
        const result = await api.authenticateTelegram({
          telegramId: session.user.id,
          displayName: session.user.displayName,
          phone: phone.trim(),
        });
        onSuccess(result.user);
      }
    } catch (e) {
      onError(message(e));
    } finally {
      onBusy(false);
    }
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
        <h1>Masuk dengan Telegram.</h1>
        <p className={styles.authIntro}>Nomor telepon Telegram menjadi login sekaligus menghubungkan akun MTProto.</p>
        <label className={styles.field}>
          {step === 'phone' ? 'Nomor telepon Telegram' : step === 'code' ? 'Kode Telegram' : 'Password 2FA Telegram'}
          <input
            autoFocus
            type={step === 'password' ? 'password' : 'text'}
            value={step === 'phone' ? phone : step === 'code' ? code : password}
            onChange={(e) => {
              if (step === 'phone') setPhone(e.target.value);
              else if (step === 'code') setCode(e.target.value);
              else setPassword(e.target.value);
            }}
            placeholder={step === 'phone' ? '+628123456789' : step === 'code' ? '12345' : 'Password 2FA'}
            autoComplete={step === 'password' ? 'current-password' : 'one-time-code'}
          />
        </label>
        {error && <div className={styles.formError} role="alert"><Icon name="info" size={16} />{error}</div>}
        <button className={styles.primaryButton} disabled={busy} onClick={submit}>
          {busy ? 'Menghubungkan…' : step === 'phone' ? 'Kirim kode Telegram' : step === 'code' ? 'Verifikasi kode' : 'Verifikasi 2FA'}
        </button>
        <small className={styles.secureNote}>Telegram tidak mengirim password atau session ke server Teledrive.</small>
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
function GalleryView({ items, thumbnails, menuId, setMenuId, onMutate, onOpen }: {
  items: FolderItem[];
  thumbnails: Record<string, string>;
  menuId: string | null;
  setMenuId: (id: string | null) => void;
  onMutate: (kind: 'folder' | 'object', action: 'rename' | 'move' | 'delete' | 'restore' | 'purge', id: string, name?: string) => void;
  onOpen: (item: FolderItem) => void;
}) {
  return <div className={styles.galleryGrid}>
    {items.map((item) => (
      <article className={styles.galleryCard} key={item.id}>
        <button className={styles.galleryOpen} onClick={() => onOpen(item)}>
          <div className={styles.galleryThumb}><GalleryThumbnail item={item} src={thumbnails[item.id]} /></div>
          <b>{item.name}</b>
          <small>{item.kind === 'folder' ? 'Folder' : formatSize(item.size)}</small>
        </button>
        <button className={styles.galleryMenu} onClick={() => setMenuId(menuId === item.id ? null : item.id)} aria-label={`Opsi ${item.name}`}>
          <Icon name="more" size={18} />
        </button>
        {menuId === item.id && <div className={styles.rowMenuPopup} role="menu">
          <button role="menuitem" onClick={() => onMutate(item.kind, 'rename', item.id, item.name)}>Ganti nama</button>
          <button role="menuitem" onClick={() => onMutate(item.kind, 'move', item.id, item.name)}>Pindahkan ke</button>
          <button role="menuitem" className={styles.dangerAction} onClick={() => onMutate(item.kind, 'delete', item.id, item.name)}>Pindahkan ke sampah</button>
        </div>}
      </article>
    ))}
  </div>;
}

function GalleryThumbnail({ item, src }: { item: FolderItem; src?: string }) {
  const cacheKey = `thumbnail:${item.id}:${item.updatedAt}`;
  const [preview, setPreview] = useState(src);
  useEffect(() => {
    if (src || item.kind === 'folder') return;
    let active = true;
    void getThumbnail(cacheKey).then((cached) => {
      if (active && cached) setPreview(cached);
    }).catch(() => undefined);
    return () => {
      active = false;
    };
  }, [cacheKey, item.kind, src]);
  useEffect(() => {
    if (src || item.kind === 'folder' || !item.mime?.startsWith('image/') && !item.mime?.startsWith('video/')) return;
    const controller = createDownloadController();
    let active = true;
    void controller.loadPreview(item.id).then(async (result) => {
      if (item.mime?.startsWith('video/')) {
        if (active) setPreview(result.url);
        const video = document.createElement('video');
        video.src = result.url;
        video.muted = true;
        video.playsInline = true;
        video.preload = 'auto';
        await new Promise<void>((resolve) => {
          const finish = () => resolve();
          video.addEventListener('loadeddata', finish, { once: true });
          video.addEventListener('error', finish, { once: true });
          video.load();
        });
        if (video.readyState >= 2 && video.duration > 0) {
          video.currentTime = 0;
          await new Promise<void>((resolve) => {
            video.addEventListener('seeked', () => resolve(), { once: true });
            window.setTimeout(resolve, 1000);
          });
        }
        if (video.videoWidth && video.videoHeight) {
          const canvas = document.createElement('canvas');
          const scale = Math.min(1, 640 / video.videoWidth);
          canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
          canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
          canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height);
          const dataUrl = canvas.toDataURL('image/jpeg', 0.65);
          await setThumbnail(cacheKey, dataUrl).catch(() => undefined);
          if (active) setPreview(dataUrl);
        }
        result.revoke();
      } else {
        const image = new Image();
        image.src = result.url;
        await new Promise<void>((resolve) => {
          image.onload = () => resolve();
          image.onerror = () => resolve();
        });
        if (image.naturalWidth && image.naturalHeight) {
          const canvas = document.createElement('canvas');
          const scale = Math.min(1, 640 / image.naturalWidth);
          canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
          canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
          canvas.getContext('2d')?.drawImage(image, 0, 0, canvas.width, canvas.height);
          const dataUrl = canvas.toDataURL('image/jpeg', 0.72);
          await setThumbnail(cacheKey, dataUrl).catch(() => undefined);
          if (active) setPreview(dataUrl);
        }
        result.revoke();
      }
    }).catch(() => undefined);
    return () => {
      active = false;
    };
  }, [item.id, item.kind, item.mime, src]);
  if (item.kind === 'folder') return <span className={styles.galleryPlaceholder}><Icon name="folder" size={28} /></span>;
  return preview ? (
    item.mime?.startsWith('video/') ? <video src={preview} muted preload="metadata" /> : <img src={preview} alt="" />
  ) : <span className={`${styles.galleryPlaceholder} ${mimeStyle(item.mime)}`}><Icon name="info" size={28} /></span>;
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
              <small>
                {percent}% · {progress?.completedParts ?? 0}/{progress?.totalParts ?? 0} bagian
              </small>
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
  onPurgeAll,
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
  items: ObjectListItem[];
  loading: boolean;
  error: string;
  cursor: string | null;
  onLoadMore: () => void;
  onRetry: () => void;
  onPurgeAll: () => Promise<void>;
  onMutate: (
    kind: 'folder' | 'object',
    action: 'rename' | 'move' | 'delete' | 'restore' | 'purge',
    id: string,
    name?: string,
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
               ? 'File dan folder dihapus dari Drive. Retensi dan status berasal dari server.'
               : 'File yang baru diubah atau diunggah.'}
           </p>
           {trashView && (
             <button className={styles.secondaryButton} onClick={onPurgeAll} disabled={loading || !items.length}>
               Hapus semua
             </button>
           )}
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
  item: ObjectListItem;
  trash: boolean;
  onMutate: (
    kind: 'folder' | 'object',
    action: 'rename' | 'move' | 'delete' | 'restore' | 'purge',
    id: string,
    name?: string,
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
  const folder = item.type === 'folder';
  const mime = item.mime ?? 'application/octet-stream';
  const downloadable = { id: item.id, name: item.name, mime, size: item.size };
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
      <span className={`${styles.fileIcon} ${folder ? styles.folderIcon : mimeStyle(mime)}`}>
        {folder ? <Icon name="folder" size={20} /> : <b>{mime.split('/')[1]?.slice(0, 4).toUpperCase() || 'FILE'}</b>}
      </span>
      <button className={styles.fileName} onClick={() => !folder && onPreview(downloadable)}>
        <b>{item.name}</b>
        <small>
          {formatSize(item.size)} ·{' '}
          {trash && item.deletedAt ? 'Dihapus ' + new Date(item.deletedAt).toLocaleDateString('id-ID') : 'File'}
        </small>
      </button>
      <span className={styles.fileDate}>
        {formatDate(...(trash ? [item.deletedAt, item.updatedAt, item.createdAt] : [item.updatedAt, item.createdAt]))}
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
                <button role="menuitem" onClick={() => onMutate(folder ? 'folder' : 'object', 'restore', item.id, item.name)}>
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
          <small>{uploads.length} file · status nyata</small>
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
                    ? `${percent}% · ${progress.completedParts}/${progress.totalParts} bagian`
                    : 'Menunggu mulai'}
                </small>
                {item.error && <small className={styles.uploadError}>{telegramError(item.error)}</small>}
              </div>
              {item.error ? (
                <button className={styles.retryButton} onClick={() => onRetry(item)}>
                  Coba lagi
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
  onLogout,
}: {
  settings: React.MutableRefObject<{ chunkSize: number; concurrency: number }>;
  onLogout: () => Promise<void>;
}) {
  async function exportData() {
    const data = await api.exportWorkspace();
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `ruang-export-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }
  return (
    <div className={styles.settings}>
      <div className={styles.eyebrow}>PREFERENSI</div>
      <h1>Pengaturan</h1>
      <p className={styles.subtle}>Upload dan data lokal perangkat ini.</p>
      <section className={styles.settingsCard}>
        <h2>Upload</h2>
        <div className={styles.settingLine}>
          <span>
            <b>Concurrency</b>
            <small>Bagian bersamaan untuk upload berikutnya</small>
          </span>
          <select defaultValue="3" onChange={(e) => (settings.current.concurrency = Number(e.target.value))}>
            <option value="1">1 bagian</option>
            <option value="2">2 bagian</option>
            <option value="3">3 bagian</option>
            <option value="4">4 bagian</option>
          </select>
        </div>
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
          Ekspor manifest untuk recovery metadata. File blob tidak pernah diproksikan melalui Worker.
        </p>
        <div className={styles.flowButtons}>
          <button className={styles.textButton} onClick={exportData}>
            Ekspor metadata JSON <Icon name="download" size={16} />
          </button>
          <button className={styles.textButton} onClick={onLogout}>
            Keluar dari Ruang
          </button>
        </div>
      </section>
    </div>
  );
}
