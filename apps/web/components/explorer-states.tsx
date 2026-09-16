'use client';

import { Icon } from './icon';
import styles from '../app/page.module.css';

export function Empty({ query, context = 'folder' }: { query?: string; context?: 'folder' | 'recent' | 'trash' | 'search' }) {
  const mode = query ? 'search' : context;
  const copy = {
    folder: { icon: 'folder', title: 'Folder masih kosong', text: 'Unggah file atau buat folder baru untuk mulai.' },
    search: {
      icon: 'search',
      title: 'File tidak ditemukan',
      text: `Tidak ada hasil untuk “${query}”. Coba kata kunci lain.`,
    },
    recent: {
      icon: 'clock',
      title: 'Belum ada aktivitas terbaru',
      text: 'File yang baru diunggah atau diubah akan muncul di sini.',
    },
    trash: { icon: 'trash', title: 'Sampah kosong', text: 'Item yang dihapus dari Drive akan ditahan di sini.' },
  }[mode];
  return (
    <div className={styles.empty}>
      <span className={styles.emptyArt}>
        <Icon name={copy.icon} size={30} />
      </span>
      <h2>{copy.title}</h2>
      <p>{copy.text}</p>
    </div>
  );
}

export function ErrorState({
  error,
  onRetry,
  title = 'Drive tidak dapat dimuat',
}: {
  error: string;
  onRetry: () => void;
  title?: string;
}) {
  return (
    <div className={styles.errorState} role="alert">
      <Icon name="info" />
      <div>
        <b>{title}</b>
        <p>{error}</p>
        <button className={styles.textButton} onClick={onRetry}>
          Coba lagi
        </button>
      </div>
    </div>
  );
}

export function GridSkeleton() {
  return (
    <div className={styles.skeletonGrid} aria-hidden="true">
      {Array.from({ length: 8 }, (_, index) => (
        <div className={styles.skeletonCard} key={index}>
          <div className={styles.skeletonThumb} />
          <div className={styles.skeletonLine} />
          <div className={`${styles.skeletonLine} ${styles.skeletonLineShort}`} />
        </div>
      ))}
    </div>
  );
}

export function ListSkeleton() {
  return (
    <div aria-hidden="true">
      {Array.from({ length: 6 }, (_, index) => (
        <div className={styles.skeletonRow} key={index}>
          <span className={styles.skeletonRowIcon} />
          <div>
            <div className={styles.skeletonLine} />
            <div className={`${styles.skeletonLine} ${styles.skeletonLineShort}`} />
          </div>
        </div>
      ))}
    </div>
  );
}
