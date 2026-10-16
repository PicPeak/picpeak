/**
 * Keyboard focus on a tile (issue 2074). The action buttons live in an overlay
 * that is `opacity-0` until hover, and opacity hides pixels, not focus: Tab
 * moved focus onto buttons nobody could see. The overlay and the checkbox now
 * reveal on :focus-visible (not :focus-within, so a mouse click leaves the
 * tile as it was). jsdom does not evaluate selectors from Tailwind classes, so
 * this pins the classes, and the tile's labels going through i18n.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { PhotoCard } from '../PhotoCard';
import type { Photo } from '../../../types';

vi.mock('../../common', () => ({
  AuthenticatedImage: ({ src, alt }: { src: string; alt?: string }) => (
    <img data-testid="tile" src={src} alt={alt} />
  ),
}));
vi.mock('../../../contexts/GuestIdentityContext', () => ({
  useGuestIdentityOptional: () => null,
}));

const DE: Record<string, string> = {
  'gallery.tile.viewFullSize': 'Vollbild anzeigen',
  'gallery.tile.downloadPhoto': 'Foto herunterladen',
};
vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, fallback?: unknown, opts?: Record<string, unknown>) =>
        DE[key]
        ?? (typeof fallback === 'string'
          ? fallback.replace(/\{\{(\w+)\}\}/g, (_m, k) => String(opts?.[k] ?? ''))
          : key),
      i18n: { language: 'de' }
    })
  };
});

const PHOTO = {
  id: 7, filename: 'IMG_0001.jpg', url: '/p/7', thumbnail_url: '/t/7', type: 'individual',
  size: 1, uploaded_at: '2026-01-01T00:00:00Z', width: 4000, height: 3000,
} as Photo;

const renderCard = () => render(
  <PhotoCard
    photo={PHOTO}
    isSelected={false}
    isSelectionMode={false}
    onClick={() => {}}
    onDownload={() => {}}
    onToggleSelect={() => {}}
    className="group tile"
    overlayBaseClassName="absolute inset-0 flex items-center justify-center gap-2"
    imageProps={{ src: '/t/7', alt: PHOTO.filename }}
    allowDownloads
  />,
);

describe('PhotoCard keyboard focus (issue 2074)', () => {
  it('reveals the overlay and the checkbox when a control inside takes keyboard focus', () => {
    const { container } = renderCard();
    const overlay = screen.getByRole('button', { name: 'Vollbild anzeigen' }).parentElement as HTMLElement;
    for (const cls of ['has-[:focus-visible]:opacity-100', 'has-[:focus-visible]:pointer-events-auto']) {
      expect(overlay.classList.contains(cls)).toBe(true);
    }
    const checkbox = container.querySelector('[role="checkbox"]') as HTMLElement;
    // The checkbox is the focused element itself, which :has() (descendants
    // only) does not match.
    for (const cls of ['focus-visible:opacity-100', 'focus-visible:pointer-events-auto']) {
      expect(checkbox.classList.contains(cls)).toBe(true);
    }
  });

  it('takes the overlay labels from the locale', () => {
    renderCard();
    expect(screen.getByRole('button', { name: 'Vollbild anzeigen' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Foto herunterladen' })).toBeInTheDocument();
  });
});
