/**
 * Download limit (issue 1560): the tile's download button shows as
 * unavailable once nothing is left, except for photos already downloaded.
 * It stays clickable (aria-disabled, not disabled) so the click reaches the
 * handler that explains the refusal instead of falling through to the tile.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { PhotoCard } from '../PhotoCard';
import { DownloadQuotaProvider } from '../../../contexts/DownloadQuotaContext';
import type { Photo } from '../../../types';

vi.mock('../../common', () => ({
  AuthenticatedImage: ({ src, alt }: { src: string; alt?: string }) => <img src={src} alt={alt} />,
}));
vi.mock('../../../contexts/GuestIdentityContext', () => ({
  useGuestIdentityOptional: () => null,
}));
vi.mock('react-toastify', () => ({ toast: { error: vi.fn() } }));

const photo = (over: Partial<Photo> = {}) => ({
  id: 7,
  filename: 'IMG_0001.jpg',
  url: '/p/7',
  thumbnail_url: '/t/7',
  type: 'individual',
  size: 1,
  uploaded_at: '2026-01-01T00:00:00Z',
  width: 4000,
  height: 3000,
  ...over,
}) as Photo;

function renderCard(p: Photo, event: Record<string, unknown>, onDownload = vi.fn(), onClick = vi.fn()) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <DownloadQuotaProvider slug="g" event={event as any}>
        <PhotoCard
          photo={p}
          isSelected={false}
          isSelectionMode={false}
          onClick={onClick}
          onDownload={onDownload}
          onToggleSelect={() => {}}
          imageProps={{ src: '/t/7', alt: 'IMG_0001.jpg' }}
          allowDownloads
        />
      </DownloadQuotaProvider>
    </QueryClientProvider>,
  );
  return { onDownload, onClick, button: screen.getByRole('button', { name: 'Download photo' }) };
}

const EXHAUSTED = { download_limit: 1, downloads_used: 1, downloads_remaining: 0 };

describe('PhotoCard download button under a download limit (issue 1560)', () => {
  it('is marked unavailable for a new photo once nothing is left, and still reaches the handler', () => {
    const { button, onDownload, onClick } = renderCard(photo(), EXHAUSTED);
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button.getAttribute('title')).toMatch(/Download limit reached/);
    fireEvent.click(button);
    expect(onDownload).toHaveBeenCalledTimes(1);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('stays available for a photo already downloaded', () => {
    const { button } = renderCard(photo({ download_granted: true }), EXHAUSTED);
    expect(button).not.toHaveAttribute('aria-disabled');
  });

  it('stays available on an unlimited gallery', () => {
    const { button } = renderCard(photo(), { download_limit: null });
    expect(button).not.toHaveAttribute('aria-disabled');
  });
});
