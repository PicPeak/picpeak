import { beforeEach, expect, it, vi } from 'vitest';
import { api } from '../../config/api';
import { contractsService } from '../contracts.service';

vi.mock('../../config/api', () => ({ api: { post: vi.fn() } }));
const post = vi.mocked(api.post);
beforeEach(() => { post.mockReset(); });

// Issue 1447: the key is what lets a retried create return the draft an
// earlier, unconfirmed attempt already made instead of creating a second one.
it('sends the Idempotency-Key header and passes the replay flag through', async () => {
  post.mockResolvedValueOnce({ data: { data: { contract: { id: 5 }, replayed: true } } });

  const result = await contractsService.create({ customerAccountId: 3 }, { idempotencyKey: 'key-12345678' });

  expect(post).toHaveBeenCalledWith('/admin/contracts', { customerAccountId: 3 }, { headers: { 'Idempotency-Key': 'key-12345678' } });
  expect(result).toEqual({ contract: { id: 5 }, replayed: true });
});

it('sends no header when no key is given', async () => {
  post.mockResolvedValueOnce({ data: { data: { contract: { id: 6 } } } });

  await contractsService.create({ customerAccountId: 3 });

  expect(post).toHaveBeenCalledWith('/admin/contracts', { customerAccountId: 3 }, undefined);
});
