export type MediaThumbnailResult =
  | { status: 'ready'; blob: Blob; mime: 'image/jpeg'; width: number; height: number }
  | { status: 'unsupported' }
  | { status: 'failed' };

export type CreateMediaThumbnailOptions = { maxDimension?: number; timeoutMs?: number };

const DEFAULT_MAX_DIMENSION = 640;
const DEFAULT_TIMEOUT_MS = 8000;

function drawToBlob(
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  maxDimension: number,
): Promise<Blob | null> {
  const scale = Math.min(1, maxDimension / Math.max(sourceWidth, sourceHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(sourceWidth * scale));
  canvas.height = Math.max(1, Math.round(sourceHeight * scale));
  const context = canvas.getContext('2d');
  if (!context) return Promise.resolve(null);
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => {
    try {
      canvas.toBlob((value) => resolve(value), 'image/jpeg', 0.72);
    } catch {
      resolve(null);
    }
  });
}

async function loadImageElement(url: string, timeoutMs: number): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image();
    const finish = (result: HTMLImageElement | null) => {
      clearTimeout(timer);
      image.onload = null;
      image.onerror = null;
      resolve(result);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    image.onload = () => finish(image.naturalWidth > 0 && image.naturalHeight > 0 ? image : null);
    image.onerror = () => finish(null);
    image.src = url;
  });
}

async function loadVideoElement(url: string, timeoutMs: number): Promise<HTMLVideoElement | null> {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    let settled = false;
    let timer: number | undefined;
    const finish = (result: HTMLVideoElement | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.removeEventListener('loadeddata', onLoaded);
      video.removeEventListener('error', onError);
      video.removeEventListener('seeked', onSeeked);
      resolve(result);
    };
    const onLoaded = () => {
      if (video.readyState < 2 || video.videoWidth <= 0 || video.videoHeight <= 0) {
        finish(null);
        return;
      }
      const target = Number.isFinite(video.duration) && video.duration > 0 ? Math.min(video.duration * 0.1, 3) : 0;
      if (target > 0.05) {
        video.currentTime = target;
        timer = window.setTimeout(() => finish(video), timeoutMs);
        return;
      }
      finish(video);
    };
    const onSeeked = () => finish(video);
    const onError = () => finish(null);
    timer = window.setTimeout(() => finish(null), timeoutMs);
    video.addEventListener('loadeddata', onLoaded, { once: true });
    video.addEventListener('error', onError, { once: true });
    video.addEventListener('seeked', onSeeked);
    video.src = url;
    video.load();
  });
}

export async function createMediaThumbnail(
  file: File,
  options: CreateMediaThumbnailOptions = {},
): Promise<MediaThumbnailResult> {
  if (typeof document === 'undefined') return { status: 'unsupported' };
  const maxDimension = options.maxDimension ?? DEFAULT_MAX_DIMENSION;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const isImage = file.type.startsWith('image/');
  const isVideo = file.type.startsWith('video/');
  if (!isImage && !isVideo) return { status: 'unsupported' };
  const url = URL.createObjectURL(file);
  try {
    const element = isVideo ? await loadVideoElement(url, timeoutMs) : await loadImageElement(url, timeoutMs);
    if (!element) return { status: 'failed' };
    const width = isVideo ? (element as HTMLVideoElement).videoWidth : (element as HTMLImageElement).naturalWidth;
    const height = isVideo ? (element as HTMLVideoElement).videoHeight : (element as HTMLImageElement).naturalHeight;
    if (!width || !height) return { status: 'failed' };
    const blob = await drawToBlob(element, width, height, maxDimension);
    if (!blob) return { status: 'failed' };
    return { status: 'ready', blob, mime: 'image/jpeg', width, height };
  } catch {
    return { status: 'failed' };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function encodeImageFromUrl(
  url: string,
  options: CreateMediaThumbnailOptions = {},
): Promise<string | null> {
  if (typeof document === 'undefined') return null;
  const element = await loadImageElement(url, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  if (!element) return null;
  const blob = await drawToBlob(element, element.naturalWidth, element.naturalHeight, options.maxDimension ?? DEFAULT_MAX_DIMENSION);
  if (!blob) return null;
  return blobToDataURL(blob);
}

export async function captureVideoFrameFromUrl(
  url: string,
  options: CreateMediaThumbnailOptions = {},
): Promise<string | null> {
  if (typeof document === 'undefined') return null;
  const element = await loadVideoElement(url, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  if (!element) return null;
  const blob = await drawToBlob(element, element.videoWidth, element.videoHeight, options.maxDimension ?? DEFAULT_MAX_DIMENSION);
  if (!blob) return null;
  return blobToDataURL(blob);
}

export async function blobToDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('Thumbnail data URL conversion failed'));
    reader.readAsDataURL(blob);
  });
}
