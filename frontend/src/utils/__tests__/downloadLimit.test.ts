/**
 * Download limit (issue 1560) — the client-side arithmetic and the refusal
 * handling every download transport goes through.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-toastify', () => ({ toast: { error: vi.fn() } }));
vi.mock('i18next', () => ({
  default: { t: (_key: string, opts?: any) => (typeof opts === 'string' ? opts : opts?.defaultValue ?? _key) },
}));

import { toast } from 'react-toastify';
import {
  DOWNLOAD_QUOTA_CHANGED_EVENT,
  DOWNLOAD_LIMIT_SHOWN_EVENT,
  DownloadLimitError,
  downloadCost,
  markGalleryLimited,
  quotaAllows,
  quotaFromEvent,
  readDownloadLimitError,
  showDownloadLimitReached,
  withDownloadLimit,
} from '../downloadLimit';

const refusal = (body: unknown, status = 403) => ({
  response: {
    status,
    data: new Blob([JSON.stringify(body)], { type: 'application/json' }),
  },
});

describe('quota arithmetic', () => {
  it('treats a missing or zero limit as unlimited', () => {
    expect(quotaFromEvent(undefined).limited).toBe(false);
    expect(quotaFromEvent({ download_limit: null }).limited).toBe(false);
    expect(quotaFromEvent({ download_limit: 0 }).limited).toBe(false);
    expect(quotaAllows(quotaFromEvent(null), [{ id: 1 }, { id: 2 }])).toBe(true);
  });

  it('prices a selection by its new photos only', () => {
    const photos = [
      { id: 1, download_granted: true },
      { id: 2, download_granted: false },
      { id: 3 },
    ];
    expect(downloadCost(photos)).toBe(2);
  });

  it('refuses the eleventh photo of a ten-photo package, and allows re-downloads', () => {
    const quota = quotaFromEvent({ download_limit: 10, downloads_used: 9, downloads_remaining: 1 });
    expect(quota).toEqual({ limited: true, limit: 10, used: 9, remaining: 1, previewOnly: false });
    expect(quotaAllows(quota, [{ id: 10 }])).toBe(true);
    expect(quotaAllows(quota, [{ id: 10 }, { id: 11 }])).toBe(false);
    // Already-downloaded photos ride along for free.
    expect(quotaAllows(quota, [{ id: 1, download_granted: true }, { id: 10 }])).toBe(true);
  });

  it('gives a share-link guest no quota, only the preview-size note', () => {
    // The server sends a guest no limit: they never draw on the client's quota.
    const quota = quotaFromEvent({ download_limit: null, download_preview_only: true });
    expect(quota).toEqual({ limited: false, limit: null, used: 0, remaining: null, previewOnly: true });
    expect(quotaAllows(quota, [{ id: 1 }, { id: 2 }])).toBe(true);
  });

  it('does not charge photos the server drops for a category with downloads off', () => {
    const quota = quotaFromEvent({ download_limit: 10, downloads_used: 9, downloads_remaining: 1 });
    expect(quotaAllows(quota, [{ id: 10 }, { id: 11, category_allow_downloads: false }])).toBe(true);
  });
});

describe('readDownloadLimitError', () => {
  it('reads the refusal out of a blob error body', async () => {
    const info = await readDownloadLimitError(refusal({
      code: 'DOWNLOAD_LIMIT_REACHED', limit: 10, used: 10, remaining: 0,
    }));
    expect(info).toEqual({ limit: 10, used: 10, remaining: 0 });
  });

  it("reads a guest's refusal of an original that has no preview-size copy", async () => {
    const info = await readDownloadLimitError(refusal({
      code: 'DOWNLOAD_LIMIT_REACHED', remaining: 0, preview_only: true,
    }));
    expect(info).toMatchObject({ remaining: 0, previewOnly: true });
    showDownloadLimitReached(info!);
    expect(vi.mocked(toast.error).mock.calls.at(-1)![0]).toBe('This video is available to the client only.');
    vi.mocked(toast.error).mockClear();
  });

  it('ignores other 403s and other statuses', async () => {
    expect(await readDownloadLimitError(refusal({ error: 'Downloads are disabled for this gallery' }))).toBeNull();
    expect(await readDownloadLimitError(refusal({ code: 'DOWNLOAD_LIMIT_REACHED' }, 500))).toBeNull();
    expect(await readDownloadLimitError(new Error('network'))).toBeNull();
  });
});

describe('withDownloadLimit', () => {
  afterEach(() => {
    markGalleryLimited('g', false);
    vi.mocked(toast.error).mockClear();
  });

  it('turns a refusal into one clear message and a DownloadLimitError', async () => {
    const onChanged = vi.fn();
    window.addEventListener(DOWNLOAD_QUOTA_CHANGED_EVENT, onChanged);
    await expect(withDownloadLimit('g', () => Promise.reject(refusal({
      code: 'DOWNLOAD_LIMIT_REACHED', limit: 10, used: 10, remaining: 0,
    })))).rejects.toBeInstanceOf(DownloadLimitError);
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast.error).mock.calls[0][0]).toMatch(/Download limit reached/);
    expect(onChanged).toHaveBeenCalledTimes(1);
    window.removeEventListener(DOWNLOAD_QUOTA_CHANGED_EVENT, onChanged);
  });

  it('passes any other failure through untouched', async () => {
    const boom = new Error('boom');
    await expect(withDownloadLimit('g', () => Promise.reject(boom))).rejects.toBe(boom);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('refreshes the quota after a success only on a limited gallery', async () => {
    const onChanged = vi.fn();
    window.addEventListener(DOWNLOAD_QUOTA_CHANGED_EVENT, onChanged);
    await withDownloadLimit('g', () => Promise.resolve('ok'));
    expect(onChanged).not.toHaveBeenCalled();
    markGalleryLimited('g', true);
    await withDownloadLimit('g', () => Promise.resolve('ok'));
    expect(onChanged).toHaveBeenCalledTimes(1);
    window.removeEventListener(DOWNLOAD_QUOTA_CHANGED_EVENT, onChanged);
  });
});

describe('a refusal decided from the cached quota', () => {
  it('asks the gallery to re-read its quota, which an admin may have reset', () => {
    const listener = vi.fn();
    window.addEventListener(DOWNLOAD_LIMIT_SHOWN_EVENT, listener);
    showDownloadLimitReached({ remaining: 0 });
    window.removeEventListener(DOWNLOAD_LIMIT_SHOWN_EVENT, listener);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
