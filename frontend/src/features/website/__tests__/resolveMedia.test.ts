/**
 * The editor asks for the thumbnails of every image a site uses at once; the
 * server takes at most 500 references per request (issue 2618).
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../config/api', () => ({
  api: {
    post: vi.fn(async (_url: string, body: { refs: { source: string; id: number }[] }) => ({
      data: { urls: Object.fromEntries(body.refs.map((r) => [`${r.source}:${r.id}`, `/site-media/${r.id}`])) },
    })),
  },
}));

import { api } from '../../../config/api';
import { websiteService } from '../../../services/website.service';

describe('websiteService.resolveMedia', () => {
  it('sends each image once, in requests of at most 500', async () => {
    const refs = Array.from({ length: 1400 }, (_, i) => ({ source: 'photo' as const, id: (i % 700) + 1, alt: 'x' }));
    const urls = await websiteService.resolveMedia(refs);
    const calls = vi.mocked(api.post).mock.calls;
    expect(calls).toHaveLength(2);
    const sent = calls.flatMap(([, body]) => (body as { refs: unknown[] }).refs);
    expect(sent).toHaveLength(700);
    for (const [, body] of calls) expect((body as { refs: unknown[] }).refs.length).toBeLessThanOrEqual(500);
    expect(Object.keys(urls)).toHaveLength(700);
    expect(urls['photo:700']).toBe('/site-media/700');
  });
});
