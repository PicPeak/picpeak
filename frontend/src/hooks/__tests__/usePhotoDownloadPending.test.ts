/**
 * Issue 2043: a download whose request never settles must not lock its photo
 * until a reload, and the late settle of an expired one must not clear the
 * mark of a newer download of the same photo.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { beginPhotoDownload, endPhotoDownload, isPhotoDownloadPending } from '../usePhotoDownloadPending';

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
});
