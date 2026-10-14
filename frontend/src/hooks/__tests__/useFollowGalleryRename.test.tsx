import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation, useParams } from 'react-router-dom';
import {
  MAX_GALLERY_RENAME_HOPS,
  renamedGalleryPath,
  renamedGallerySlug,
  useFollowGalleryRename,
} from '../useFollowGalleryRename';

const renamed = (newSlug: unknown) => ({
  response: { status: 301, data: { redirect: true, newSlug, message: 'Gallery has been renamed' } },
});

afterEach(cleanup);

describe('renamedGallerySlug', () => {
  it('reads the new slug from a 301 rename answer', () => {
    expect(renamedGallerySlug(renamed('wedding-new-2026-06-05'))).toBe('wedding-new-2026-06-05');
  });

  it('ignores anything else', () => {
    expect(renamedGallerySlug(null)).toBeNull();
    expect(renamedGallerySlug({ response: { status: 404, data: { error: 'Gallery not found' } } })).toBeNull();
    expect(renamedGallerySlug({ response: { status: 301, data: {} } })).toBeNull();
    expect(renamedGallerySlug(renamed(42))).toBeNull();
  });

  it('refuses a slug that would leave its path segment', () => {
    for (const bad of ['', '..', 'a/b', 'a?b', 'a#b', 'a\\b']) {
      expect(renamedGallerySlug(renamed(bad))).toBeNull();
    }
  });
});

describe('renamedGalleryPath', () => {
  it('swaps only the slug segment', () => {
    expect(renamedGalleryPath('/gallery/old', 'new')).toBe('/gallery/new');
    expect(renamedGalleryPath('/gallery/old/abc123', 'new')).toBe('/gallery/new/abc123');
    expect(renamedGalleryPath('/gallery/old/client-access', 'new')).toBe('/gallery/new/client-access');
  });

  it('leaves non-gallery paths alone', () => {
    expect(renamedGalleryPath('/admin/events', 'new')).toBeNull();
  });
});

// Answers the old slug with a rename, the way /info does after a rename.
// `answers` maps a slug to the slug it was renamed to.
function Probe({ answers }: { answers: Record<string, string> }) {
  const { slug = '' } = useParams();
  const location = useLocation();
  const error = answers[slug] ? renamed(answers[slug]) : null;
  const following = useFollowGalleryRename(error, slug);
  return (
    <div>
      <span data-testid="location">{`${location.pathname}${location.search}${location.hash}`}</span>
      <span data-testid="state">{following ? 'following' : error ? 'not-found' : 'gallery'}</span>
    </div>
  );
}

function renderAt(entry: string, answers: Record<string, string>) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/gallery/:slug/*" element={<Probe answers={answers} />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('useFollowGalleryRename', () => {
  it('moves to the new slug, keeping the token segment, query and hash', async () => {
    renderAt('/gallery/old-slug/abc123?photo=42#top', { 'old-slug': 'new-slug' });
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('gallery'));
    expect(screen.getByTestId('location').textContent).toBe('/gallery/new-slug/abc123?photo=42#top');
  });

  it('keeps the client-access path and its link token', async () => {
    renderAt('/gallery/old-slug/client-access?token=t1', { 'old-slug': 'new-slug' });
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('gallery'));
    expect(screen.getByTestId('location').textContent).toBe('/gallery/new-slug/client-access?token=t1');
  });

  it('follows a short chain', async () => {
    renderAt('/gallery/a', { a: 'b', b: 'c' });
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/gallery/c'));
    expect(screen.getByTestId('state').textContent).toBe('gallery');
  });

  it(`stops a redirect cycle after ${MAX_GALLERY_RENAME_HOPS} hops and shows not found`, async () => {
    renderAt('/gallery/a', { a: 'b', b: 'a' });
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('not-found'));
  });

  it('shows not found for a redirect to the slug that was asked for', async () => {
    renderAt('/gallery/a', { a: 'a' });
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('not-found'));
    expect(screen.getByTestId('location').textContent).toBe('/gallery/a');
  });

  it('shows not found when a chain ends in a self-redirect', async () => {
    renderAt('/gallery/b', { b: 'a', a: 'a' });
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/gallery/a'));
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('not-found'));
  });
});
