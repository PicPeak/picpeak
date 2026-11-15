/**
 * PicTransfer files go up in requests a proxy lets through.
 *
 * Behind Cloudflare (Free/Pro) a request body above 100 MB never arrives, and
 * the transfer service posted the create form and every deliverable file in
 * one multipart request. Files that fit still go that way; a file larger than
 * one request goes in 10 MB chunks, and a set too large for one request in
 * several. A new send waits for its files before its mail goes out, and a file
 * that does not land is reported, never silently lost (stable: the mail is
 * sent through POST /:id/deliver once everything landed).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/api', () => ({
  api: { get: vi.fn(), post: vi.fn(), delete: vi.fn(), patch: vi.fn() },
}));

import { api } from '../../config/api';
import { transfersService } from '../transfers.service';
import { planTransferFiles } from '../../utils/uploadBatches';

const MB = 1024 * 1024;
const CHUNK = 10 * MB;
const CLOUDFLARE_LIMIT = 100 * MB;

/** A File-like whose bytes are never allocated: only slice() is read. */
function bigFile(name: string, size: number): File {
  return {
    name, size, type: 'video/mp4',
    slice: (start: number, end: number) => ({ size: end - start, start, end }),
  } as unknown as File;
}
const smallFile = (name: string, bytes = 10) => new File(['x'.repeat(bytes)], name, { type: 'application/pdf' });

const transfer = { id: 7, kind: 'send', recipients: [] };
const post = vi.mocked(api.post);
const urls = () => post.mock.calls.map(([url]) => url as string);

function serve({ failChunk = -1 }: { failChunk?: number } = {}) {
  post.mockImplementation(async (url: string, body?: unknown) => {
    if (url === '/admin/transfers') return { data: { transfer, rejected_files: [], dropped_files: [] } };
    if (url.endsWith('/chunked-upload/init')) {
      const { fileSize } = body as { fileSize: number };
      return { data: { uploadId: 'u1', chunkSize: CHUNK, expectedChunks: Math.ceil(fileSize / CHUNK) } };
    }
    if (url.includes('/chunk/')) {
      if (Number(url.split('/').pop()) === failChunk) throw { response: { status: 500, data: { error: 'boom' } } };
      return { data: {} };
    }
    if (url.endsWith('/complete')) return { data: { transfer } };
    if (url.endsWith('/upload-files')) return { data: { transfer, rejected_files: [] } };
    if (url.endsWith('/deliver')) return { data: { transfer, sent: 1, already_delivered: false } };
    throw new Error(`unexpected POST ${url}`);
  });
  vi.mocked(api.get).mockResolvedValue({ data: { transfer } });
  vi.mocked(api.delete).mockResolvedValue({ data: {} });
}

beforeEach(() => {
  vi.clearAllMocks();
  serve();
});

describe('planTransferFiles', () => {
  it('chunks a file above the request budget and batches the rest under it', () => {
    const files = [bigFile('film.mp4', 500 * MB), ...Array.from({ length: 12 }, (_, i) => bigFile(`p${i}.jpg`, 20 * MB))];
    const { batches, chunked } = planTransferFiles(files, 50);
    expect(chunked.map((f) => f.name)).toEqual(['film.mp4']);
    expect(batches.flat()).toHaveLength(12);
    for (const batch of batches) {
      expect(batch.reduce((sum, f) => sum + f.size, 0)).toBeLessThan(CLOUDFLARE_LIMIT);
    }
  });

  it('never lets a raised server budget past the proxy limit', () => {
    const { chunked } = planTransferFiles([bigFile('a.zip', 300 * MB)], 25, 2048 * MB);
    expect(chunked).toHaveLength(1);
  });
});

describe('creating a send', () => {
  it('keeps small files in the one create request, as before', async () => {
    await transfersService.create({ title: 'Finals', files: [smallFile('a.pdf'), smallFile('b.pdf')] });

    expect(urls()).toEqual(['/admin/transfers']);
    const form = post.mock.calls[0][1] as FormData;
    expect(form.getAll('files')).toHaveLength(2);
    expect(form.get('pendingFiles')).toBeNull();
  });

  it('uploads a large file in chunks under 100 MB into the new send, then sends the mail', async () => {
    const film = bigFile('film.mp4', 250 * MB + 5);
    const progress: number[] = [];
    const result = await transfersService.create({
      title: 'Wedding', files: [smallFile('notes.pdf'), film],
      deliveryMethod: 'email', recipientEmails: ['client@example.com'],
    }, (pct) => progress.push(pct));

    const form = post.mock.calls[0][1] as FormData;
    expect(form.getAll('files').map((f) => (f as File).name)).toEqual(['notes.pdf']);
    expect(form.get('pendingFiles')).toBe('1');

    const chunkCalls = post.mock.calls.filter(([url]) => (url as string).includes('/chunk/'));
    expect(chunkCalls).toHaveLength(26);
    for (const [url, body, config] of chunkCalls) {
      expect(url).toMatch(/^\/admin\/transfers\/7\/chunked-upload\/u1\/chunk\/\d+$/);
      expect((body as { size: number }).size).toBeLessThanOrEqual(CHUNK);
      expect((config as { headers: Record<string, string> }).headers['Content-Type']).toBe('application/octet-stream');
    }
    // The mail waits for the file: deliver comes last, with the recipients.
    expect(urls().at(-1)).toBe('/admin/transfers/7/deliver');
    expect(post.mock.calls.at(-1)![1]).toEqual({ recipientEmails: ['client@example.com'] });
    expect(result.failed_files).toEqual([]);
    expect(result.delivery_held).toBe(false);
    expect(progress.at(-1)).toBe(100);
  });

  it('reports a chunked file that failed and keeps the mail held', async () => {
    serve({ failChunk: 3 });
    const result = await transfersService.create({
      title: 'Wedding', photoIds: [1], files: [bigFile('film.mp4', 120 * MB)],
      deliveryMethod: 'email', recipientEmails: ['client@example.com'],
    });

    expect(api.delete).toHaveBeenCalledWith('/admin/transfers/7/chunked-upload/u1', expect.anything());
    expect(result.failed_files).toEqual(['film.mp4']);
    expect(result.delivery_held).toBe(true);
    expect(urls()).not.toContain('/admin/transfers/7/deliver');
  });
});

describe('creating a send when the connection drops at the end', () => {
  it('still answers with the created send and what did not land', async () => {
    serve({ failChunk: 1 });
    vi.mocked(api.get).mockRejectedValue(new Error('Network Error'));
    const result = await transfersService.create({ title: 'Wedding', photoIds: [1], files: [bigFile('film.mp4', 120 * MB)] });
    expect(result.id).toBe(7);
    expect(result.failed_files).toEqual(['film.mp4']);
  });
});

describe('adding files to a transfer', () => {
  it('keeps one multipart request for files that fit', async () => {
    await transfersService.uploadFiles(7, [smallFile('a.pdf')]);
    expect(urls()).toEqual(['/admin/transfers/7/upload-files']);
  });

  it('sends a large file in chunks', async () => {
    const result = await transfersService.uploadFiles(7, [bigFile('film.mp4', 150 * MB)]);
    expect(urls()[0]).toBe('/admin/transfers/7/chunked-upload/init');
    expect(urls()).not.toContain('/admin/transfers/7/deliver');
    expect(result.failed_files).toEqual([]);
  });

  it('keeps the result when the refresh after the upload fails', async () => {
    vi.mocked(api.get).mockRejectedValue(new Error('Network Error'));
    const result = await transfersService.uploadFiles(7, [bigFile('film.mp4', 150 * MB), smallFile('a.pdf')]);
    expect(result.id).toBe(7);
    expect(result.failed_files).toEqual([]);
  });

  it('throws when no file landed', async () => {
    serve({ failChunk: 0 });
    await expect(transfersService.uploadFiles(7, [bigFile('film.mp4', 150 * MB)])).rejects.toMatchObject({
      response: { status: 500 },
    });
  });
});

describe('public file-request upload', () => {
  it('sends one large file in chunks on the request link', async () => {
    post.mockImplementation(async (url: string, body?: unknown) => {
      if (url.endsWith('/init')) {
        return { data: { uploadId: 'p1', chunkSize: CHUNK, expectedChunks: Math.ceil((body as { fileSize: number }).fileSize / CHUNK) } };
      }
      if (url.endsWith('/complete')) return { data: { uploaded: 1, files: [] } };
      return { data: {} };
    });
    const result = await transfersService.uploadChunked('tok', bigFile('raw.zip', 101 * MB));
    expect(result.uploaded).toBe(1);
    expect(urls()[0]).toBe('/public/transfer-upload/tok/chunked-upload/init');
    expect(urls().filter((u) => u.includes('/chunk/'))).toHaveLength(11);
  });
});
