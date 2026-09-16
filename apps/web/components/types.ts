import type { DownloadProgress } from '../lib/download-controller';
import type { createDownloadController } from '../lib/download-controller';

export type DownloadItem = {
  id: string;
  name: string;
  mime: string;
  size: number | null;
  partCount?: number | null;
  thumbnail?: import('../lib/api').ThumbnailReference | null;
};

export type DownloadAction = {
  controller: ReturnType<typeof createDownloadController>;
  progress?: DownloadProgress;
  error?: string;
  done?: boolean;
};

export type SelectedEntry = { id: string; kind: 'folder' | 'object'; name: string; parentId?: string };
