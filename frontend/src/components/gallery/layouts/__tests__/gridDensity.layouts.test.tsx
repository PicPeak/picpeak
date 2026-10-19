/**
 * Issue 1733, E4: the gallery viewer picks a tile density in the toolbar, the
 * browser remembers it, and every tile layout applies it on top of the
 * theme's own columns / thumbnailScale. "Standard" is the theme, untouched.
 */
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { GridGalleryLayout, gridGeometryClass } from '../GridGalleryLayout';
import { MasonryGalleryLayout } from '../MasonryGalleryLayout';
import { MosaicGalleryLayout } from '../MosaicGalleryLayout';
import { TimelineGalleryLayout } from '../TimelineGalleryLayout';
import { GridDensityControl } from '../../GridDensityControl';
import {
  GRID_DENSITY_STORAGE_KEY,
  GridDensityOffered,
  resetGridDensityForTests,
  setGridDensity,
} from '../../gridDensity';
import type { Photo } from '../../../../types';

const theme = vi.hoisted(() => ({ gallerySettings: {} as Record<string, unknown> }));

vi.mock('react-intersection-observer', () => ({ useInView: () => ({ ref: vi.fn(), inView: true }) }));
vi.mock('../../../common', () => ({
  AuthenticatedImage: ({ src, alt, className }: { src: string; alt?: string; className?: string }) =>
    <img src={src} alt={alt} className={className} />,
  PoweredBy: () => null,
  Button: ({ children, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...rest}>{children}</button>,
}));
vi.mock('../../../../contexts/ThemeContext', () => ({ useTheme: () => ({ theme }) }));
vi.mock('../../../../contexts/GuestIdentityContext', () => ({ useGuestIdentityOptional: () => null }));
vi.mock('../../../../services/feedback.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../services/feedback.service')>()),
  feedbackService: { submitFeedback: vi.fn(), getPhotoFeedback: vi.fn() },
}));
vi.mock('../../../../hooks/useLocalizedDate', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../hooks/useLocalizedDate')>()),
  useLocalizedDate: () => ({ formatTime: (v: string) => v }),
}));
vi.mock('react-toastify', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key),
    i18n: { language: 'en' },
  }),
}));

const photos: Photo[] = [1, 2, 3].map((id) => ({
  id,
  filename: `IMG_${id}.jpg`,
  url: `/api/gallery/x/photo/${id}`,
  thumbnail_url: `/api/gallery/x/thumbnail/${id}`,
  type: 'individual',
  size: 1,
  uploaded_at: '2026-01-01T00:00:00Z',
  width: 4000,
  height: 3000,
} as Photo));

const props = {
  photos,
  slug: 'x',
  onPhotoClick: vi.fn(),
  onDownload: vi.fn(),
  selectedPhotos: new Set<number>(),
  isSelectionMode: false,
  allowDownloads: true,
  feedbackEnabled: false,
} as never;

// `offered`: the page renders the switch, as GalleryView does with either
// control style.
function mount(ui: React.ReactElement, offered = true) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <GridDensityOffered.Provider value={offered}>{ui}</GridDensityOffered.Provider>
    </QueryClientProvider>,
  );
}

const classesOf = (el: Element | null) => (el?.className || '').toString().split(/\s+/).filter(Boolean);

beforeEach(() => {
  theme.gallerySettings = {};
  window.localStorage.clear();
  resetGridDensityForTests();
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 1440 });
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('gridGeometryClass with the viewer density', () => {
  const cols = (cls: string) => classesOf({ className: cls } as Element).filter((c) => c.includes('grid-cols-'));

  it('leaves the theme geometry alone at the default density', () => {
    expect(cols(gridGeometryClass({}))).toEqual(['grid-cols-2', 'sm:grid-cols-3', 'lg:grid-cols-4', 'xl:grid-cols-5']);
    expect(gridGeometryClass({}, 'default')).toBe(gridGeometryClass({}));
  });

  it('adds a column for compact and takes one for large, on top of thumbnailScale', () => {
    expect(cols(gridGeometryClass({}, 'compact'))).toEqual(['grid-cols-3', 'sm:grid-cols-4', 'lg:grid-cols-5', 'xl:grid-cols-6']);
    expect(cols(gridGeometryClass({ thumbnailScale: 'lg' }, 'large'))).toEqual(['grid-cols-1', 'sm:grid-cols-1', 'lg:grid-cols-2', 'xl:grid-cols-3']);
  });

  it('stays inside the safelisted 1..12 range', () => {
    const widest = gridGeometryClass({ gridColumns: { mobile: 1, tablet: 8, desktop: 8 }, thumbnailScale: 'xs' }, 'compact');
    expect(cols(widest)).toContain('xl:grid-cols-12');
    const narrowest = gridGeometryClass({ gridColumns: { mobile: 1, tablet: 1, desktop: 1 }, thumbnailScale: 'xl' }, 'large');
    expect(cols(narrowest)).toEqual(['grid-cols-1', 'sm:grid-cols-1', 'lg:grid-cols-1', 'xl:grid-cols-1']);
  });
});

describe('GridDensityControl', () => {
  it.each(['carousel', 'gallery-premium', 'gallery-story'])('renders nothing for %s', (layout) => {
    const { container } = mount(<GridDensityControl layout={layout} />);
    expect(container).toBeEmptyDOMElement();
  });

  it.each([undefined, 'grid', 'masonry', 'mosaic', 'timeline'])('renders three options for %s', (layout) => {
    mount(<GridDensityControl layout={layout} />);
    expect(screen.getByRole('group', { name: 'Tile size' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'gallery.density.default' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('re-lays the grid, remembers the choice, and forgets it on Standard', () => {
    const { container } = mount(
      <>
        <GridDensityControl layout="grid" />
        <GridGalleryLayout {...props} />
      </>,
    );
    const grid = () => container.querySelector('.photo-grid');
    expect(classesOf(grid())).toContain('lg:grid-cols-4');

    fireEvent.click(screen.getByRole('button', { name: 'gallery.density.large' }));
    expect(classesOf(grid())).toContain('lg:grid-cols-3');
    expect(screen.getByRole('button', { name: 'gallery.density.large' })).toHaveAttribute('aria-pressed', 'true');
    expect(window.localStorage.getItem(GRID_DENSITY_STORAGE_KEY)).toBe('large');

    fireEvent.click(screen.getByRole('button', { name: 'gallery.density.default' }));
    expect(classesOf(grid())).toContain('lg:grid-cols-4');
    expect(window.localStorage.getItem(GRID_DENSITY_STORAGE_KEY)).toBeNull();
  });

  it('starts from the stored choice on a new page load and ignores junk', () => {
    window.localStorage.setItem(GRID_DENSITY_STORAGE_KEY, 'compact');
    const { container, unmount } = mount(<GridGalleryLayout {...props} />);
    expect(classesOf(container.querySelector('.photo-grid'))).toContain('lg:grid-cols-5');
    unmount();

    window.localStorage.setItem(GRID_DENSITY_STORAGE_KEY, 'huge');
    resetGridDensityForTests();
    const again = mount(<GridGalleryLayout {...props} />);
    expect(classesOf(again.container.querySelector('.photo-grid'))).toContain('lg:grid-cols-4');
  });

  it('keeps the theme size where the page offers no switch to change it back', () => {
    window.localStorage.setItem(GRID_DENSITY_STORAGE_KEY, 'compact');
    const { container } = mount(<GridGalleryLayout {...props} />, false);
    expect(classesOf(container.querySelector('.photo-grid'))).toContain('lg:grid-cols-4');
    act(() => setGridDensity('large'));
    expect(classesOf(container.querySelector('.photo-grid'))).toContain('lg:grid-cols-4');
  });

  it('still switches for the page when storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    const { container } = mount(
      <>
        <GridDensityControl layout="grid" />
        <GridGalleryLayout {...props} />
      </>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'gallery.density.compact' }));
    expect(classesOf(container.querySelector('.photo-grid'))).toContain('lg:grid-cols-5');
  });
});

describe('the other tile layouts follow the density', () => {
  it('Timeline moves its fixed 2/3/4 columns', () => {
    const { container } = mount(<TimelineGalleryLayout {...props} />);
    const grid = () => classesOf(container.querySelector('.photo-grid'));
    expect(grid()).toEqual(expect.arrayContaining(['grid-cols-2', 'sm:grid-cols-3', 'lg:grid-cols-4']));
    act(() => setGridDensity('large'));
    expect(grid()).toEqual(expect.arrayContaining(['grid-cols-1', 'sm:grid-cols-2', 'lg:grid-cols-3']));
  });

  it('Mosaic changes its column count', () => {
    const { container } = mount(<MosaicGalleryLayout {...props} />);
    const grid = () => container.querySelector('.photo-grid') as HTMLElement;
    expect(grid().style.columnCount).toBe('4');
    act(() => setGridDensity('compact'));
    expect(grid().style.columnCount).toBe('5');
  });

  it('Masonry quilted scales its cell size', () => {
    theme.gallerySettings = { masonryMode: 'quilted' };
    const { container } = mount(<MasonryGalleryLayout {...props} />);
    const grid = () => container.querySelector('.photo-grid') as HTMLElement;
    expect(grid().style.gridAutoRows).toBe('200px');
    act(() => setGridDensity('large'));
    expect(grid().style.gridAutoRows).toBe('270px');
    act(() => setGridDensity('compact'));
    expect(grid().style.gridAutoRows).toBe('150px');
  });
});
