import { toast as toastify } from 'react-toastify';
// The initialised global instance (i18n/config sets it up), as utils/money.ts
// uses it: importing the config here would drag the whole i18n bootstrap into
// every component that touches a download.
import i18n from 'i18next';

// Download limit (issue 1560). The server counts distinct photos: a photo the
// gallery already downloaded is free again. Everything here is a UX layer on
// top of that; the server refuses with 403 DOWNLOAD_LIMIT_REACHED regardless.

export const DOWNLOAD_LIMIT_CODE = 'DOWNLOAD_LIMIT_REACHED';

// Fired on window after a download went through or was refused on a limited
// gallery, so the gallery re-reads its quota. detail: { slug }.
export const DOWNLOAD_QUOTA_CHANGED_EVENT = 'picpeak:download-quota-changed';

export interface DownloadLimitInfo {
  limit?: number;
  used?: number;
  remaining?: number;
}

export class DownloadLimitError extends Error {
  info: DownloadLimitInfo;

  constructor(info: DownloadLimitInfo) {
    super('Download limit reached');
    this.name = 'DownloadLimitError';
    this.info = info;
  }
}

export const isDownloadLimitError = (error: unknown): error is DownloadLimitError =>
  error instanceof DownloadLimitError;

// Galleries whose last photos payload carried a limit. The service layer uses
// it to pick download transports whose refusal it can see: a hidden-anchor
// navigation lands a 403 as a broken download the page never hears about.
const limitedSlugs = new Set<string>();

export function markGalleryLimited(slug: string, limited: boolean): void {
  if (limited) limitedSlugs.add(slug);
  else limitedSlugs.delete(slug);
}

export const isGalleryLimited = (slug: string): boolean => limitedSlugs.has(slug);

function blobText(blob: Blob): Promise<string> {
  if (typeof blob.text === 'function') return blob.text();
  // Older WebKit ships Blob without text().
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

async function readErrorBody(data: unknown): Promise<Record<string, unknown> | null> {
  if (!data) return null;
  // Downloads request `responseType: 'blob'`, so the JSON error arrives as one.
  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    try {
      return JSON.parse(await blobText(data));
    } catch {
      return null;
    }
  }
  if (typeof data === 'object') return data as Record<string, unknown>;
  return null;
}

/** The limit details when `error` is the server's DOWNLOAD_LIMIT_REACHED refusal. */
export async function readDownloadLimitError(error: unknown): Promise<DownloadLimitInfo | null> {
  const response = (error as { response?: { status?: number; data?: unknown } })?.response;
  if (!response || response.status !== 403) return null;
  const body = await readErrorBody(response.data);
  if (!body || body.code !== DOWNLOAD_LIMIT_CODE) return null;
  return {
    limit: typeof body.limit === 'number' ? body.limit : undefined,
    used: typeof body.used === 'number' ? body.used : undefined,
    remaining: typeof body.remaining === 'number' ? body.remaining : undefined,
  };
}

/** The refusal in the viewer's language, for tooltips on disabled buttons. */
const REACHED_FALLBACK = 'Download limit reached. Please contact your photographer for more downloads.';
export const downloadLimitReachedMessage = (): string =>
  // An i18next that is not initialised yet returns nothing; the tooltip
  // must still say something.
  i18n.t('gallery.downloadLimit.reached', REACHED_FALLBACK) || REACHED_FALLBACK;

export function showDownloadLimitReached(info?: DownloadLimitInfo): void {
  const message = info && typeof info.remaining === 'number' && info.remaining > 0
    ? i18n.t('gallery.downloadLimit.notEnough', {
      remaining: info.remaining,
      defaultValue: 'Only {{remaining}} downloads left. Please select fewer photos or contact your photographer.',
    })
    : downloadLimitReachedMessage();
  // One toast however many buttons raced into the refusal.
  toastify.error(message, { toastId: 'download-limit-reached' });
}

export function notifyDownloadQuotaChanged(slug: string): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(DOWNLOAD_QUOTA_CHANGED_EVENT, { detail: { slug } }));
}

/**
 * Run a download on a gallery. On a limited gallery a success refreshes the
 * quota, and a refusal shows the limit message and rethrows as a
 * DownloadLimitError, so callers can skip their generic "download failed".
 */
export async function withDownloadLimit<T>(slug: string, run: () => Promise<T>): Promise<T> {
  try {
    const result = await run();
    if (isGalleryLimited(slug)) notifyDownloadQuotaChanged(slug);
    return result;
  } catch (error) {
    if (isDownloadLimitError(error)) throw error;
    const info = await readDownloadLimitError(error);
    if (!info) throw error;
    showDownloadLimitReached(info);
    notifyDownloadQuotaChanged(slug);
    throw new DownloadLimitError(info);
  }
}

// ── Quota arithmetic ────────────────────────────────────────────────────────

export interface QuotaPhoto {
  id: number;
  download_granted?: boolean;
}

export interface DownloadQuota {
  limited: boolean;
  limit: number | null;
  used: number;
  remaining: number | null;
}

export const UNLIMITED_QUOTA: DownloadQuota = { limited: false, limit: null, used: 0, remaining: null };

export function quotaFromEvent(event?: {
  download_limit?: number | null;
  downloads_used?: number;
  downloads_remaining?: number | null;
} | null): DownloadQuota {
  const limit = event?.download_limit;
  if (typeof limit !== 'number' || limit <= 0) return UNLIMITED_QUOTA;
  const used = event?.downloads_used ?? 0;
  return {
    limited: true,
    limit,
    used,
    remaining: event?.downloads_remaining ?? Math.max(0, limit - used),
  };
}

/** How many quota slots downloading these photos costs: granted ones are free. */
export const downloadCost = (photos: QuotaPhoto[]): number =>
  photos.filter((photo) => !photo.download_granted).length;

/** Whether the quota allows downloading all of these photos in one go. */
export function quotaAllows(quota: DownloadQuota, photos: QuotaPhoto[]): boolean {
  if (!quota.limited) return true;
  return downloadCost(photos) <= (quota.remaining ?? 0);
}
