/**
 * Gallery Premium's columns, gap and hero fit come from the theme (issues
 * 2425, 2429). Unset, the album keeps 1, 2 and 3 columns with a 16 px gap and
 * the hero its 16:9 crop.
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import type { Photo } from '../../../types';
import type { ThemeConfig } from '../../../types/theme.types';

const { album, theme } = vi.hoisted(() => ({
  album: vi.fn(),
  theme: { current: undefined as ThemeConfig | undefined },
}));
vi.mock('../../../contexts/ThemeContext', async () => ({
  ...await vi.importActual('../../../contexts/ThemeContext'),
  useOptionalTheme: () => (theme.current ? { theme: theme.current } : undefined),
}));
vi.mock('../../../hooks/usePublicSettings', () => ({ usePublicSettings: () => ({ data: undefined }) }));
vi.mock('react-i18next', async () => ({
  ...await vi.importActual('react-i18next'),
  useTranslation: () => ({ t: (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key), i18n: { language: 'en' } }),
}));
vi.mock('../../../hooks/useGallery', () => ({ useDownloadPhoto: () => ({ mutate: vi.fn() }) }));
vi.mock('../../../contexts/GuestIdentityContext', () => ({ useGuestIdentityOptional: () => null }));
vi.mock('../../../hooks/useInputMode', () => ({ useInputMode: () => 'mouse' }));
vi.mock('react-intersection-observer', () => ({ useInView: () => ({ ref: vi.fn(), inView: true }) }));
vi.mock('../../../services/gallery.service', () => ({ galleryService: { trackPhotoView: vi.fn() } }));
vi.mock('../../common', async () => ({ ...await vi.importActual('../../common'), PoweredBy: () => null }));
vi.mock('react-photo-album', () => ({
  MasonryPhotoAlbum: (props: any) => {
    album(props);
    return null;
  },
}));
vi.mock('yet-another-react-lightbox', () => ({ default: () => null }));
vi.mock('yet-another-react-lightbox/plugins/thumbnails', () => ({ default: () => null }));
vi.mock('yet-another-react-lightbox/plugins/zoom', () => ({ default: () => null }));
vi.mock('yet-another-react-lightbox/plugins/fullscreen', () => ({ default: () => null }));
vi.mock('yet-another-react-lightbox/plugins/download', () => ({ default: () => null }));
vi.mock('yet-another-react-lightbox/plugins/captions', () => ({ default: () => null }));

import { GalleryPremiumLayout } from '../layouts/GalleryPremiumLayout';

const photos = [1, 2].map((id) => ({
  id, filename: `photo-${id}.jpg`,
  url: `/api/gallery/demo/photo/${id}`, thumbnail_url: `/api/gallery/demo/thumbnail/${id}`,
  hero_url: `/api/gallery/demo/hero/${id}`, slideshow_url: `/api/gallery/demo/preview/${id}`,
  width: 4000, height: 6000, type: 'individual', size: 1, uploaded_at: '2026-01-01T00:00:00Z',
})) as Photo[];

const mount = (config?: ThemeConfig) => {
  theme.current = config;
  return render(<GalleryPremiumLayout photos={photos} slug="demo" onPhotoClick={vi.fn()} onDownload={vi.fn()} />);
};
const lastAlbum = () => album.mock.calls.at(-1)![0];
const heroBg = (container: HTMLElement) => container.querySelector('.gallery-premium-hero-bg') as HTMLElement;

afterEach(() => {
  cleanup();
  album.mockClear();
});

describe('Gallery Premium geometry', () => {
  it('keeps 1, 2 and 3 columns with a 16 px gap when nothing is set', () => {
    mount();
    const { columns, spacing } = lastAlbum();
    expect([columns(390), columns(800), columns(1280)]).toEqual([1, 2, 3]);
    expect(spacing).toBe(16);
  });

  it('uses the admin\'s columns per device and gap', () => {
    mount({ gallerySettings: { premiumColumns: { mobile: 2, tablet: 3, desktop: 5 }, premiumGap: 3 } });
    const { columns, spacing } = lastAlbum();
    expect([columns(390), columns(800), columns(1280)]).toEqual([2, 3, 5]);
    expect(spacing).toBe(3);
  });

  it('crops the hero to 16:9 by default and shows the whole photo when asked', () => {
    const { container, unmount } = mount();
    expect(heroBg(container).style.backgroundImage).toContain('/hero/1');
    expect(heroBg(container)).not.toHaveClass('gallery-premium-hero-bg--whole');
    expect(container.querySelector('.gallery-premium-hero-backdrop')).toBeNull();
    unmount();

    const whole = mount({ heroFit: 'contain' });
    expect(heroBg(whole.container).style.backgroundImage).toContain('/preview/1');
    expect(heroBg(whole.container)).toHaveClass('gallery-premium-hero-bg--whole');
    // The blurred fill behind it is the same URL, fetched once.
    const backdrop = whole.container.querySelector('.gallery-premium-hero-backdrop') as HTMLElement;
    expect(backdrop.style.backgroundImage).toBe(heroBg(whole.container).style.backgroundImage);
  });
});
