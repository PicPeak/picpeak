/**
 * The upload tracker's endpoints live on the photos router, which server.js
 * mounts at /api/admin/photos. The service polled /api/admin/uploads/... —
 * never routed — so useUploadProgress 404'd every 1.5s and the upload UI
 * never learned that processing had finished; the grid's retry button hit
 * the same wall. Pin the routed paths.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getMock = vi.fn();
const postMock = vi.fn();
vi.mock('../../config/api', () => ({
  api: { get: (...a: any[]) => getMock(...a), post: (...a: any[]) => postMock(...a), defaults: { baseURL: '/api' } },
}));

import { uploadsService } from '../uploads.service';

describe('uploadsService', () => {
  beforeEach(() => { getMock.mockReset(); postMock.mockReset(); });

  it('polls the status route under the photos mount', async () => {
    getMock.mockResolvedValue({ data: { upload_id: 'u1' } });
    await uploadsService.getStatus('u1');
    expect(getMock).toHaveBeenCalledWith('/admin/photos/uploads/u1/status');
  });

  it('retries a photo under the same mount', async () => {
    postMock.mockResolvedValue({ data: { id: 7, status: 'pending' } });
    await uploadsService.retryPhoto(7);
    expect(postMock).toHaveBeenCalledWith('/admin/photos/photos/7/retry');
  });

  it('streams from the same mount', () => {
    expect(uploadsService.streamUrl('u1')).toBe('/api/admin/photos/uploads/u1/stream');
  });
});
