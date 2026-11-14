/**
 * The gallery login sends the full-link token (issue 2356) when this tab
 * opened the full link, and forgets a token the server no longer accepts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const post = vi.hoisted(() => vi.fn());
vi.mock('../../config/api', () => ({ api: { post } }));

import { authService } from '../auth.service';
import { getFullLinkToken, setFullLinkToken } from '../../utils/galleryFullLink';

const ok = { data: { token: 't', event: { id: 1, event_name: 'x' } } };

describe('verifyGalleryPassword and the full link', () => {
  beforeEach(() => {
    sessionStorage.clear();
    post.mockReset();
  });

  it('sends no full token for an ordinary login', async () => {
    post.mockResolvedValue(ok);
    await authService.verifyGalleryPassword('party', 'pw');
    expect(post.mock.calls[0][1]).not.toHaveProperty('full_token');
  });

  it('sends the token the full link kept for this gallery', async () => {
    setFullLinkToken('party', 'f'.repeat(64));
    post.mockResolvedValue(ok);
    await authService.verifyGalleryPassword('party', 'pw');
    expect(post.mock.calls[0][1]).toMatchObject({ slug: 'party', password: 'pw', full_token: 'f'.repeat(64) });
    await authService.verifyGalleryPassword('other', 'pw');
    expect(post.mock.calls[1][1]).not.toHaveProperty('full_token');
  });

  it('forgets a rotated full link, but not on a wrong password', async () => {
    setFullLinkToken('party', 'f'.repeat(64));
    post.mockRejectedValueOnce(Object.assign(new Error('401'), { response: { data: { error: 'Invalid gallery or password' } } }));
    await expect(authService.verifyGalleryPassword('party', 'bad')).rejects.toThrow();
    expect(getFullLinkToken('party')).toBe('f'.repeat(64));
    post.mockRejectedValueOnce(Object.assign(new Error('401'), { response: { data: { code: 'FULL_LINK_INVALID' } } }));
    await expect(authService.verifyGalleryPassword('party', 'pw')).rejects.toThrow();
    expect(getFullLinkToken('party')).toBeNull();
  });
});
