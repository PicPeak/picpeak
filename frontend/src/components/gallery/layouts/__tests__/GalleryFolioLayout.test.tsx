/**
 * Gallery Folio (issue 2617): the layout renders the photos through the
 * shared tile and lightbox, wires the gallery's toolbox into its nav, and
 * applies its design options from the theme.
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { Photo } from '../../../../types';
import type { ThemeConfig } from '../../../../types/theme.types';

const { album, theme, feedback } = vi.hoisted(() => ({
  album: vi.fn(),
  theme: { current: undefined as ThemeConfig | undefined },
  feedback: { submitFeedback: vi.fn().mockResolvedValue({}) },
}));

vi.mock('react-i18next', async () => ({
  ...await vi.importActual('react-i18next'),
  useTranslation: () => ({
    t: (key: string, fallback?: unknown) => {
      if (typeof fallback === 'string') return fallback;
      const count = (fallback as { count?: number } | undefined)?.count;
      return count === undefined ? key : `${key}:${count}`;
    },
    i18n: { language: 'en' },
  }),
}));
vi.mock('../../../../contexts/ThemeContext', async () => ({
  ...await vi.importActual('../../../../contexts/ThemeContext'),
  useOptionalTheme: () => (theme.current ? { theme: theme.current } : undefined),
}));
vi.mock('../../../common', async () => ({
  ...await vi.importActual('../../../common'),
  AuthenticatedImage: ({ src, alt, className, style }: { src: string; alt?: string; className?: string; style?: React.CSSProperties }) => (
    <img src={src} alt={alt} className={className} style={style} />
  ),
  PoweredBy: () => null,
}));
vi.mock('../../TileImage', () => ({
  TileImage: ({ src, alt, className }: { src: string; alt?: string; className?: string }) => (
    <img src={src} alt={alt} className={className} />
  ),
}));
vi.mock('../../../../services/feedback.service', () => ({ feedbackService: feedback }));
vi.mock('../../../../contexts/GuestIdentityContext', () => ({ useGuestIdentityOptional: () => null }));
vi.mock('../../../../hooks/useInputMode', () => ({ useInputMode: () => 'mouse' }));
vi.mock('react-intersection-observer', () => ({ useInView: () => ({ ref: vi.fn(), inView: true }) }));
// The album lays tiles out from the measured width, which jsdom does not
// have: hand every photo to the tile renderer at a fixed size instead.
vi.mock('react-photo-album', () => ({
  MasonryPhotoAlbum: (props: { photos: Array<{ key: string }>; render: { photo: (p: unknown, c: unknown) => React.ReactNode } }) => {
    album(props);
    return (
      <div data-testid="album">
        {props.photos.map((photo, index) => (
          <React.Fragment key={photo.key}>{props.render.photo({}, { photo, index, width: 300, height: 200 })}</React.Fragment>
        ))}
      </div>
    );
  },
}));

import { GalleryFolioLayout } from '../GalleryFolioLayout';

const photos = [1, 2, 3].map((id) => ({
  id,
  filename: `photo-${id}.jpg`,
  url: `/api/gallery/demo/photo/${id}`,
  thumbnail_url: `/api/gallery/demo/thumbnail/${id}`,
  hero_url: `/api/gallery/demo/hero/${id}`,
  slideshow_url: `/api/gallery/demo/preview/${id}`,
  width: id === 2 ? 4000 : 6000,
  height: id === 2 ? 6000 : 4000,
  type: 'individual',
  size: 1,
  uploaded_at: '2026-01-01T00:00:00Z',
  is_liked: false,
  ...(id === 3 ? { media_type: 'video' } : {}),
})) as Photo[];

type Props = Partial<React.ComponentProps<typeof GalleryFolioLayout>>;

const mount = (props: Props = {}, config?: ThemeConfig) => {
  theme.current = config;
  const all = {
    photos,
    slug: 'demo',
    eventName: 'Hoa & Minh',
    eventDate: '2026-09-19',
    onPhotoClick: vi.fn(),
    onDownload: vi.fn(),
    ...props,
  };
  const view = render(<MemoryRouter><GalleryFolioLayout {...all} /></MemoryRouter>);
  return { ...view, props: all };
};
const root = (container: HTMLElement) => container.querySelector('.gallery-folio') as HTMLElement;
const nav = () => within(screen.getByRole('navigation', { name: 'Gallery' }));
const lastAlbum = () => album.mock.calls.at(-1)![0] as { columns: (w: number) => number; spacing: number };
const likes = { feedbackEnabled: true, feedbackOptions: { allowLikes: true, allowRatings: true, allowComments: true } };

afterEach(() => {
  cleanup();
  album.mockClear();
  feedback.submitFeedback.mockClear();
});

describe('Gallery Folio', () => {
  it('opens on a cover with the title and shows every photo with its name as alt text', () => {
    mount();
    expect(screen.getByRole('heading', { level: 1, name: 'Hoa & Minh' })).toBeInTheDocument();
    for (const name of ['photo-1.jpg', 'photo-2.jpg', 'photo-3.jpg']) {
      expect(screen.getByRole('img', { name })).toBeInTheDocument();
    }
    // In their own proportions: the album gets each photo's dimensions.
    expect(album.mock.calls[0][0].photos.map((p: { width: number; height: number }) => [p.width, p.height]))
      .toEqual([[6000, 4000], [4000, 6000], [6000, 4000]]);
    // The video carries a badge; the cover is a photo, never the video.
    expect(screen.getAllByText('Video')).toHaveLength(1);
  });

  it('crops the cover around the event\'s focal point, from the uncropped preview', () => {
    const { container } = mount({ heroImageAnchor: '30% 70%' });
    const cover = container.querySelector('.folio-cover-image') as HTMLImageElement;
    expect(cover.getAttribute('src')).toBe('/api/gallery/demo/preview/1');
    expect(cover.style.objectPosition).toBe('30% 70%');
    expect(cover).toHaveAttribute('alt', '');
  });

  it('covers a video-only gallery with the video\'s poster, never the video file', () => {
    const video = { ...photos[2], hero_url: undefined, slideshow_url: undefined } as Photo;
    const { container } = mount({ photos: [video], heroPhotoOverride: video });
    const cover = container.querySelector('.folio-cover-image') as HTMLImageElement;
    expect(cover.getAttribute('src')).toBe('/api/gallery/demo/thumbnail/3');
  });

  it('falls back to a title-only cover for a video without a poster', () => {
    const video = { ...photos[2], hero_url: undefined, slideshow_url: undefined, thumbnail_url: null } as unknown as Photo;
    const { container } = mount({ photos: [video], heroPhotoOverride: video });
    expect(container.querySelector('.folio-cover-image')).toBeNull();
    expect(root(container).dataset.cover).toBe('plain');
  });

  it('opens the shared lightbox at the clicked photo', () => {
    const onPhotoClick = vi.fn();
    mount({ onPhotoClick });
    fireEvent.click(screen.getAllByRole('button', { name: 'View full size' })[1]);
    expect(onPhotoClick).toHaveBeenCalledWith(1);
  });

  it('downloads a single photo from its tile and everything from the nav', () => {
    const onDownload = vi.fn();
    const onDownloadEverything = vi.fn();
    mount({ onDownload, onDownloadEverything, allowDownloads: true });
    fireEvent.click(screen.getAllByRole('button', { name: 'Download photo' })[0]);
    expect(onDownload).toHaveBeenCalledWith(photos[0], expect.anything());
    fireEvent.click(nav().getByRole('button', { name: 'Download All' }));
    expect(onDownloadEverything).toHaveBeenCalledTimes(1);
  });

  it('offers no download at all when downloads are off', () => {
    mount({ allowDownloads: false, onDownloadEverything: vi.fn() });
    expect(screen.queryByRole('button', { name: 'Download photo' })).toBeNull();
    expect(nav().queryByRole('button', { name: 'Download All' })).toBeNull();
  });

  it('likes a photo from its tile and counts it on the nav heart, which filters to the likes', async () => {
    const onToggleLikedOnly = vi.fn();
    mount({ ...likes, onToggleLikedOnly });
    fireEvent.click(screen.getAllByRole('button', { name: 'Like photo' })[0]);
    expect(feedback.submitFeedback).toHaveBeenCalledWith('demo', '1', expect.objectContaining({ feedback_type: 'like' }));
    expect(await screen.findByRole('button', { name: 'Unlike photo' })).toHaveAttribute('aria-pressed', 'true');
    const heart = nav().getByRole('button', { name: 'Show only photos I liked (1)' });
    fireEvent.click(heart);
    expect(onToggleLikedOnly).toHaveBeenCalledTimes(1);
  });

  it('keeps ratings and comments in the lightbox, off the quiet tile', () => {
    mount(likes);
    expect(screen.queryByRole('button', { name: 'Comment on photo' })).toBeNull();
  });

  it('runs selection through the container: select all, download selected, cancel', () => {
    const onToggleSelectionMode = vi.fn();
    const onSelectMany = vi.fn();
    const onDownloadSelected = vi.fn();
    const onDeselectAll = vi.fn();
    const { rerender, props } = mount({ onToggleSelectionMode, onPhotoSelect: vi.fn(), onSelectMany, onDownloadSelected, onDeselectAll });
    fireEvent.click(nav().getByTestId('folio-nav-select'));
    expect(onToggleSelectionMode).toHaveBeenCalledTimes(1);

    rerender(<MemoryRouter><GalleryFolioLayout {...props} isSelectionMode selectedPhotos={new Set([2])} /></MemoryRouter>);
    const bar = within(screen.getByRole('region', { name: 'Select Media' }));
    fireEvent.click(bar.getByRole('button', { name: 'Select All' }));
    expect(onSelectMany).toHaveBeenCalledWith([1, 2, 3]);
    fireEvent.click(bar.getByTestId('folio-download-selected'));
    expect(onDownloadSelected).toHaveBeenCalledTimes(1);
    fireEvent.click(bar.getByRole('button', { name: 'Cancel Selection' }));
    expect(onDeselectAll).toHaveBeenCalledTimes(1);
  });

  it('keeps select, likes and download in the nav row and puts the rest in a menu on a phone', () => {
    const handlers = { onUploadClick: vi.fn(), onLogout: vi.fn(), onManageGallery: vi.fn(), onCopyFilenames: vi.fn() };
    mount({
      ...handlers, ...likes, copyFilenamesCount: 2, onDownloadEverything: vi.fn(),
      onToggleSelectionMode: vi.fn(), onPhotoSelect: vi.fn(),
    });
    // Inline from 640 px up; the stylesheet hides these below that.
    for (const name of ['Upload Photos', 'Copy filenames (2)', 'Manage Gallery', 'Logout']) {
      expect(nav().getByRole('button', { name })).toHaveClass('folio-nav-secondary');
    }
    for (const id of ['folio-nav-select', 'folio-nav-liked', 'folio-nav-download-all']) {
      expect(nav().getByTestId(id)).not.toHaveClass('folio-nav-secondary');
    }
    // The phone's menu offers the same actions, logout last.
    fireEvent.click(nav().getByRole('button', { name: 'More actions' }));
    const items = within(screen.getByRole('menu')).getAllByRole('menuitem');
    expect(items.map((item) => item.textContent)).toEqual(['Upload Photos', 'Copy filenames (2)', 'Manage Gallery', 'Logout']);
    fireEvent.click(items[0]);
    expect(handlers.onUploadClick).toHaveBeenCalledTimes(1);
    fireEvent.click(nav().getByRole('button', { name: 'More actions' }));
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Logout' }));
    expect(handlers.onLogout).toHaveBeenCalledTimes(1);
  });

  it('has no menu when there is nothing secondary to put in it', () => {
    mount();
    expect(nav().queryByRole('button', { name: 'More actions' })).toBeNull();
  });

  it('keeps the toolbox and says why when a filter leaves nothing', () => {
    mount({ photos: [], emptyIsFiltered: true, beforeGrid: <p>toolbox</p> });
    expect(screen.getByText('toolbox')).toBeInTheDocument();
    expect(screen.getByText('No photos match your search or filters.')).toBeInTheDocument();
  });
});

describe('Gallery Folio design options', () => {
  it('defaults to paper, a full cover, 3 columns on a desktop and 2 on a phone', () => {
    const { container } = mount();
    const page = root(container);
    expect(page.dataset.palette).toBe('paper');
    expect(page.dataset.cover).toBe('full');
    expect(page.style.getPropertyValue('--color-background')).toBe('#f4f1eb');
    const { columns, spacing } = lastAlbum();
    expect([columns(390), columns(800), columns(1440)]).toEqual([2, 2, 3]);
    expect(spacing).toBe(12);
  });

  it('applies the admin\'s palette, cover, type, spacing, columns and studio label', () => {
    const { container } = mount({}, {
      gallerySettings: {
        folioPalette: 'charcoal', folioCover: 'split', folioType: 'modern', folioSpacing: 'airy',
        folioColumns: { mobile: 1, desktop: 4 }, folioStudioLabel: 'Studio Nord',
      },
    });
    const page = root(container);
    expect(page.dataset.palette).toBe('charcoal');
    expect(page.style.getPropertyValue('--color-background')).toBe('#1c1c1b');
    expect(page.style.getPropertyValue('--color-text')).toBe('#eeece7');
    expect(page.dataset.type).toBe('modern');
    expect(page.dataset.spacing).toBe('airy');
    expect(container.querySelector('.folio-cover--split')).not.toBeNull();
    expect(nav().getByText('Studio Nord')).toBeInTheDocument();
    const { columns, spacing } = lastAlbum();
    expect([columns(390), columns(800), columns(1440)]).toEqual([1, 3, 4]);
    expect(spacing).toBe(28);
  });

  it('falls back to a title-only cover when there is no photo to show', () => {
    const { container } = mount({ photos: [], suppressEmptyState: true });
    expect(root(container).dataset.cover).toBe('plain');
    expect(container.querySelector('.folio-cover-image')).toBeNull();
  });
});
