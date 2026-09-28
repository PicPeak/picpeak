/**
 * A status route that keeps failing must not be polled forever.
 *
 * The hook retried every error at four times the interval with no limit,
 * so a broken status route (a proxy that 404s it, a backend that 500s)
 * held the upload bar in "processing" for good. After
 * maxConsecutiveFailures the id is given up on: polling stops and the
 * aggregate says so, and the caller ends the session with what it knows.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const getStatus = vi.fn();
vi.mock('../../services/uploads.service', () => ({
  uploadsService: {
    getStatus: (...a: unknown[]) => getStatus(...a),
    streamUrl: () => 'about:blank',
  },
}));

import { useUploadProgress } from '../useUploadProgress';

describe('useUploadProgress stall', () => {
  beforeEach(() => getStatus.mockReset());

  it('stops polling after the configured run of failures and reports isStalled', async () => {
    getStatus.mockImplementation(() => Promise.reject(new Error('404')));
    const { result, unmount } = renderHook(() =>
      useUploadProgress(['u1'], { pollIntervalMs: 5, preferStream: false, maxConsecutiveFailures: 3 })
    );

    await waitFor(() => expect(result.current.aggregate.isStalled).toBe(true));
    const calls = getStatus.mock.calls.length;
    expect(calls).toBe(3);
    await new Promise((r) => setTimeout(r, 60));
    expect(getStatus.mock.calls.length).toBe(calls);
    // Explicit, not left to the auto-cleanup: with the mock still holding
    // three rejected results at teardown, vitest 4 reports the last one as
    // this test's error even though every rejection was caught.
    unmount();
    getStatus.mockReset();
  });

  it('a successful read resets the run', async () => {
    getStatus
      .mockRejectedValueOnce(new Error('503'))
      .mockRejectedValueOnce(new Error('503'))
      .mockResolvedValueOnce({ total: 1, pending: 1, processing: 0, complete: 0, failed: 0, photos: [] })
      .mockRejectedValueOnce(new Error('503'))
      .mockRejectedValueOnce(new Error('503'))
      .mockResolvedValue({ total: 1, pending: 0, processing: 0, complete: 1, failed: 0, photos: [] });
    const { result } = renderHook(() =>
      useUploadProgress(['u1'], { pollIntervalMs: 5, preferStream: false, maxConsecutiveFailures: 3 })
    );

    await waitFor(() => expect(result.current.aggregate.isComplete).toBe(true));
    expect(result.current.aggregate.isStalled).toBe(false);
  });
});
