/**
 * Issue 2043: a download whose request never settles must not lock its photo
 * until a reload, and the late settle of an expired one must not clear the
 * mark of a newer download of the same photo.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { beginPhotoDownload, endPhotoDownload, isPhotoDownloadPending, touchPhotoDownload } from '../usePhotoDownloadPending';

afterEach(() => vi.useRealTimers());

describe('photo download marks (issue 2043)', () => {
  it('lets a mark go after a minute when the download never settles', () => {
    vi.useFakeTimers();
    const first = beginPhotoDownload(1001);
    expect(first).not.toBeNull();
    expect(beginPhotoDownload(1001)).toBeNull();

    vi.advanceTimersByTime(59_000);
    expect(isPhotoDownloadPending(1001)).toBe(true);
    vi.advanceTimersByTime(1_000);
    expect(isPhotoDownloadPending(1001)).toBe(false);

    const second = beginPhotoDownload(1001);
    expect(second).not.toBeNull();
    // The first download settles late: the second one's mark stays.
    endPhotoDownload(1001, first!);
    expect(isPhotoDownloadPending(1001)).toBe(true);
    endPhotoDownload(1001, second!);
    expect(isPhotoDownloadPending(1001)).toBe(false);
  });

  it('keeps the mark of a slow download that is still arriving, and lets it go a minute after progress stops', () => {
    vi.useFakeTimers();
    const token = beginPhotoDownload(1002)!;
    for (let i = 0; i < 4; i += 1) {
      vi.advanceTimersByTime(50_000);
      touchPhotoDownload(1002, token);
    }
    // 200 s in, still arriving.
    expect(isPhotoDownloadPending(1002)).toBe(true);
    vi.advanceTimersByTime(59_000);
    expect(isPhotoDownloadPending(1002)).toBe(true);
    vi.advanceTimersByTime(1_000);
    expect(isPhotoDownloadPending(1002)).toBe(false);
  });

  it('ignores progress from a download whose mark already expired', () => {
    vi.useFakeTimers();
    const stale = beginPhotoDownload(1003)!;
    vi.advanceTimersByTime(60_000);
    const fresh = beginPhotoDownload(1003)!;
    vi.advanceTimersByTime(50_000);
    touchPhotoDownload(1003, stale);
    vi.advanceTimersByTime(10_000);
    expect(isPhotoDownloadPending(1003)).toBe(false);
    endPhotoDownload(1003, fresh);
  });
});
