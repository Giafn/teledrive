'use client';

import { Icon } from './icon';
import styles from '../app/page.module.css';

export type ExplorerLayout = 'grid' | 'list';
export type ExplorerSort = 'Terakhir diubah' | 'Nama A–Z' | 'Ukuran terbesar';

export const EXPLORER_SORTS: ExplorerSort[] = ['Terakhir diubah', 'Nama A–Z', 'Ukuran terbesar'];

export function ExplorerToolbar({
  count,
  sort,
  onSortChange,
  layout,
  onLayoutChange,
}: {
  count: number | null;
  sort: ExplorerSort;
  onSortChange: (sort: ExplorerSort) => void;
  layout: ExplorerLayout;
  onLayoutChange: (layout: ExplorerLayout) => void;
}) {
  return (
    <div className={styles.toolbar}>
      <span className={styles.itemCount}>{count === null ? 'Memuat…' : `${count} item`}</span>
      <div className={styles.toolbarRight}>
        <select aria-label="Urutkan file" value={sort} onChange={(event) => onSortChange(event.target.value as ExplorerSort)}>
          {EXPLORER_SORTS.map((option) => (
            <option key={option}>{option}</option>
          ))}
        </select>
        <div className={styles.segmented}>
          <button
            className={layout === 'list' ? styles.selected : ''}
            onClick={() => onLayoutChange('list')}
            aria-label="Tampilan daftar"
            aria-pressed={layout === 'list'}
          >
            <Icon name="list" size={17} />
          </button>
          <button
            className={layout === 'grid' ? styles.selected : ''}
            onClick={() => onLayoutChange('grid')}
            aria-label="Tampilan grid"
            aria-pressed={layout === 'grid'}
          >
            <Icon name="grid" size={17} />
          </button>
        </div>
      </div>
    </div>
  );
}
