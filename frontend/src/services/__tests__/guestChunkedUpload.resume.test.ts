/**
 * A chunked upload survives a dropped connection and a backgrounded page.
 *
 * Minimising Safari on iOS suspends the page and its in-flight request
 * fails; any failed chunk used to abort and delete the whole upload, so a
 * client's 1.7 GB file was lost. A chunk that fails on the way is now sent
 * again after a backoff, from that chunk on, and while the page is hidden the
 * retry waits for it to be visible without spending an attempt. A refusal,
 * or a chunk still failing after every retry, aborts as before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/api', () => ({
  api: { post: vi.fn(), delete: vi.fn() },
}));

import { api } from '../../config/api';
import {
  CHUNK_RETRY_DELAYS_MS, isUploadInterrupted, subscribeUploadInterruptions, uploadFileInChunks,
} from '../guestChunkedUpload';

const CHUNK = 10;
const post = vi.mocked(api.post);
const file = { name: 'film.mp4', size: 35, slice: (a: number, b: number) => ({ a, b }) } as unknown as File;
const chunkCalls = () => post.mock.calls.map(([url]) => url as string).filter((u) => u.includes('/chunk/'))
  .map((u) => Number(u.split('/').pop()));
const networkError = () => Object.assign(new Error('Network Error'), { code: 'ERR_NETWORK' });

let visibility: DocumentVisibilityState = 'visible';
function setVisibility(next: DocumentVisibilityState) {
  visibility = next;
  document.dispatchEvent(new Event('visibilitychange'));
}

/** Serve init/complete; `chunk` decides each chunk request in turn. */
function serve(chunk: (index: number, call: number) => unknown) {
  let calls = 0;
  post.mockImplementation(async (url: string) => {
    if (url.endsWith('/init')) return { data: { uploadId: 'u1', chunkSize: CHUNK, expectedChunks: 4 } };
    if (url.endsWith('/complete')) return { data: { ok: true } };
    const failure = chunk(Number(url.split('/').pop()), calls++);
    if (failure) throw failure;
    return { data: {} };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  visibility = 'visible';
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  vi.mocked(api.delete).mockResolvedValue({ data: {} });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('uploadFileInChunks: resuming after a failed chunk', () => {
  it('re-sends only the failed chunk after a transient failure and completes', async () => {
    serve((index, call) => (index === 2 && call === 2 ? networkError() : null));
    const upload = uploadFileInChunks('/public/transfer-upload/tok', file);
    await vi.advanceTimersByTimeAsync(CHUNK_RETRY_DELAYS_MS[0]);

    await expect(upload).resolves.toMatchObject({ data: { ok: true } });
    expect(chunkCalls()).toEqual([0, 1, 2, 2, 3]);
    expect(api.delete).not.toHaveBeenCalled();
  });

  it.each([500, 502, 503, 408, 409])('retries a %s answer', async (status) => {
    serve((index, call) => (index === 1 && call === 1 ? { response: { status, data: {} } } : null));
    const upload = uploadFileInChunks('/x', file);
    await vi.advanceTimersByTimeAsync(CHUNK_RETRY_DELAYS_MS[0]);
    await expect(upload).resolves.toBeTruthy();
    expect(chunkCalls()).toEqual([0, 1, 1, 2, 3]);
  });

  it('waits out a plain rate limit for its Retry-After', async () => {
    serve((index, call) => (index === 1 && call === 1
      ? { response: { status: 429, data: {}, headers: { 'retry-after': '5' } } } : null));
    const upload = uploadFileInChunks('/x', file);
    await vi.advanceTimersByTimeAsync(4000);
    expect(chunkCalls()).toEqual([0, 1]);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(upload).resolves.toBeTruthy();
    expect(chunkCalls()).toEqual([0, 1, 1, 2, 3]);
  });

  it.each([
    ['a validation refusal', { response: { status: 400, data: { code: 'INVALID_CHUNK' } } }],
    ['a size refusal', { response: { status: 413, data: { code: 'FILE_TOO_LARGE' } } }],
    ['an unknown upload', { response: { status: 404, data: {} } }],
    ['a quota 429', { response: { status: 429, data: { code: 'UPLOAD_QUOTA' } } }],
  ])('does not retry %s, and aborts', async (_label, failure) => {
    serve((index) => (index === 1 ? failure : null));
    await expect(uploadFileInChunks('/x', file)).rejects.toBe(failure);
    expect(chunkCalls()).toEqual([0, 1]);
    expect(api.delete).toHaveBeenCalledWith('/x/chunked-upload/u1', expect.anything());
  });

  it('gives up after the last retry, aborts and deletes the upload', async () => {
    const failure = { response: { status: 503, data: {} } };
    serve((index) => (index === 1 ? failure : null));
    const upload = uploadFileInChunks('/x', file);
    const settled = upload.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(CHUNK_RETRY_DELAYS_MS.reduce((sum, ms) => sum + ms, 0));

    expect(await settled).toBe(failure);
    expect(chunkCalls()).toEqual([0, ...Array(CHUNK_RETRY_DELAYS_MS.length + 1).fill(1)]);
    expect(post.mock.calls.some(([url]) => (url as string).endsWith('/complete'))).toBe(false);
    expect(api.delete).toHaveBeenCalledWith('/x/chunked-upload/u1', expect.anything());
    expect(isUploadInterrupted()).toBe(false);
  });

  it('waits while the page is hidden without spending attempts, then resumes', async () => {
    // The page goes to the background during chunk 1: every request fails
    // until the user comes back.
    serve((index) => (index === 1 && visibility === 'hidden' ? networkError() : null));
    setVisibility('hidden');
    const upload = uploadFileInChunks('/x', file);

    // Far longer than every retry together: still waiting, nothing aborted.
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(chunkCalls()).toEqual([0, 1]);
    expect(api.delete).not.toHaveBeenCalled();
    expect(isUploadInterrupted()).toBe(true);

    setVisibility('visible');
    await expect(upload).resolves.toBeTruthy();
    expect(chunkCalls()).toEqual([0, 1, 1, 2, 3]);
    expect(isUploadInterrupted()).toBe(false);
  });

  it('flags the upload as interrupted only while it waits to resume', async () => {
    const seen: boolean[] = [];
    const unsubscribe = subscribeUploadInterruptions(() => seen.push(isUploadInterrupted()));
    serve((index, call) => (index === 2 && call === 2 ? networkError() : null));
    const upload = uploadFileInChunks('/x', file);
    await vi.advanceTimersByTimeAsync(CHUNK_RETRY_DELAYS_MS[0]);
    await upload;
    unsubscribe();
    expect(seen).toEqual([true, false]);
  });
});
