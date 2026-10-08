import { describe, expect, it, vi } from 'vitest';
import { CAPACITY_RETRY_DELAYS_MS, isTransientUploadRefusal, retryWhileBusy } from '../uploadCapacityRetry';

const refusal = (code: string) => ({ response: { data: { code } } });

describe('retryWhileBusy', () => {
  it.each(['UPLOAD_PENDING_LIMIT', 'UPLOAD_CONCURRENCY_LIMIT', 'UPLOAD_TIMEOUT', 'UPLOAD_REQUEST_TIMEOUT'])('treats %s as transient', (code) => {
    expect(isTransientUploadRefusal(code)).toBe(true);
  });

  it.each(['UPLOAD_STORAGE_LOW', 'UPLOAD_LIFETIME_LIMIT', 'UPLOAD_QUOTA_UNAVAILABLE', 'UPLOAD_REQUEST_TOO_LARGE', undefined])('does not retry %s', async (code) => {
    expect(isTransientUploadRefusal(code)).toBe(false);
    const send = vi.fn().mockRejectedValue(refusal(code as string));
    await expect(retryWhileBusy(send, { delaysMs: [0, 0] })).rejects.toEqual(refusal(code as string));
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('waits and sends again until the server has capacity, reporting each wait', async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(refusal('UPLOAD_CONCURRENCY_LIMIT'))
      .mockRejectedValueOnce(refusal('UPLOAD_PENDING_LIMIT'))
      .mockResolvedValueOnce('stored');
    const onWaiting = vi.fn();
    await expect(retryWhileBusy(send, { delaysMs: [0, 0, 0], onWaiting })).resolves.toBe('stored');
    expect(send).toHaveBeenCalledTimes(3);
    expect(onWaiting.mock.calls.map(([w]) => w)).toEqual([{ attempt: 1, total: 3 }, null, { attempt: 2, total: 3 }, null]);
  });

  it('gives up with the refusal after the last retry', async () => {
    const send = vi.fn().mockRejectedValue(refusal('UPLOAD_PENDING_LIMIT'));
    await expect(retryWhileBusy(send, { delaysMs: [0, 0, 0] })).rejects.toEqual(refusal('UPLOAD_PENDING_LIMIT'));
    expect(send).toHaveBeenCalledTimes(4);
  });

  it('stops waiting as soon as the upload is cancelled', async () => {
    const controller = new AbortController();
    const send = vi.fn().mockRejectedValue(refusal('UPLOAD_PENDING_LIMIT'));
    const pending = retryWhileBusy(send, { delaysMs: [60000], signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toEqual(refusal('UPLOAD_PENDING_LIMIT'));
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('is bounded: ten retries within a few minutes', () => {
    expect(CAPACITY_RETRY_DELAYS_MS).toHaveLength(10);
    const total = CAPACITY_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(120000);
    expect(total).toBeLessThanOrEqual(300000);
  });
});
