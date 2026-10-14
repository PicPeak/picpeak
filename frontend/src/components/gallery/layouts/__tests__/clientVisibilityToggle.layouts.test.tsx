/**
 * Issue 1992: in Client Access Mode the per-photo hide/show (eye) button was
 * rendered by Grid only. Every tile layout must offer it, show the hidden
 * state (crossed-out eye, dimmed photo), and keep the click away from the
 * tile underneath, which would open the lightbox.
 */
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { GridGalleryLayout } from '../GridGalleryLayout';
import { MasonryGalleryLayout } from '../MasonryGalleryLayout';
import { MosaicGalleryLayout } from '../MosaicGalleryLayout';
import { TimelineGalleryLayout } from '../TimelineGalleryLayout';
import { CarouselGalleryLayout } from '../CarouselGalleryLayout';
import { __inputModeTesting } from '../../../../hooks/useInputMode';
import type { Photo } from '../../../../types';

const theme = vi.hoisted(() => ({ gallerySettings: {} as Record<string, unknown> }));

vi.mock('react-intersection-observer', () => ({ useInView: () => ({ ref: vi.fn(), inView: true }) }));
vi.mock('../../../common', () => ({
  AuthenticatedImage: ({ src, alt, className }: { src: string; alt?: string; className?: string }) =>
    <img src={src} alt={alt} className={className} />,
  PoweredBy: () => null,
  Button: ({ children, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...rest}>{children}</button>,
  Input: ({ label: _l, error: _e, ...rest }: React.InputHTMLAttributes<HTMLInputElement> & { label?: string; error?: string }) => <input {...rest} />,
}));
vi.mock('../../../../contexts/ThemeContext', () => ({ useTheme: () => ({ theme }) }));
vi.mock('../../../../contexts/GuestIdentityContext', () => ({ useGuestIdentityOptional: () => null }));
vi.mock('../../../../services/feedback.service', () => ({
  feedbackService: { submitFeedback: vi.fn(), getPhotoFeedback: vi.fn() },
}));
vi.mock('../../../../hooks/useLocalizedDate', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../hooks/useLocalizedDate')>()),
  useLocalizedDate: () => ({ formatTime: (v: string) => v }),
}));
vi.mock('react-toastify',() => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key),
    i18n: { language: 'en' },
  }),
}));

const photos: Photo[] = [
  { id: 1, visibility: 'visible' },
  { id: 2, visibility: 'hidden' },
].map(({ id, visibility }) => ({
  id,
  visibility,
  filename: `IMG_${id}.jpg`,
  url: `/api/gallery/x/photo/${id}`,
  thumbnail_url: `/api/gallery/x/thumbnail/${id}`,
  type: 'individual',
  size: 1,
  uploaded_at: '2026-01-01T00:00:00Z',
  width: 4000,
  height: 3000,
} as Photo));

const baseProps = (extra: Record<string, unknown> = {}) => ({
  photos,
  slug: 'x',
  onPhotoClick: vi.fn(),
  onDownload: vi.fn(),
  selectedPhotos: new Set<number>(),
  isSelectionMode: false,
  allowDownloads: true,
  feedbackEnabled: false,
  ...extra,
}) as never;

beforeEach(() => {
  theme.gallerySettings = {};
  Object.defineProperty(window, 'matchMedia', {
    configurable: true, writable: true,
    value: (query: string) => ({
      matches: false, media: query, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
  Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 0 });
  __inputModeTesting.reset();
  Object.defineProperty(window, 'devicePixelRatio', { value: 1, configurable: true });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 1440 });
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function mount(ui: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

type LayoutCase = {
  name: string;
  Layout: React.FC<never>;
  settings?: Record<string, unknown>;
  /** How the hidden photo is dimmed: on its own image, or on Grid's tile wrapper. */
  dims: 'image' | 'tile';
};

const cases: LayoutCase[] = [
  { name: 'Grid', Layout: GridGalleryLayout as React.FC<never>, dims: 'tile' },
  { name: 'Masonry columns', Layout: MasonryGalleryLayout as React.FC<never>, settings: { masonryMode: 'columns' }, dims: 'image' },
  { name: 'Masonry rows', Layout: MasonryGalleryLayout as React.FC<never>, settings: { masonryMode: 'rows' }, dims: 'image' },
  { name: 'Masonry justified', Layout: MasonryGalleryLayout as React.FC<never>, settings: { masonryMode: 'justified' }, dims: 'image' },
  { name: 'Masonry flickr', Layout: MasonryGalleryLayout as React.FC<never>, settings: { masonryMode: 'flickr' }, dims: 'image' },
  { name: 'Masonry quilted', Layout: MasonryGalleryLayout as React.FC<never>, settings: { masonryMode: 'quilted' }, dims: 'image' },
  { name: 'Mosaic', Layout: MosaicGalleryLayout as React.FC<never>, dims: 'image' },
  { name: 'Timeline', Layout: TimelineGalleryLayout as React.FC<never>, dims: 'image' },
];

describe.each(cases)('$name: client visibility toggle (issue 1992)', ({ Layout, settings, dims }) => {
  beforeEach(() => {
    theme.gallerySettings = settings ?? {};
  });

  it('renders an eye per photo for the client, showing the hidden state', () => {
    mount(<Layout {...baseProps({ isClient: true, onToggleVisibility: vi.fn() })} />);

    const visible = screen.getByTestId('client-visibility-toggle-1');
    const hidden = screen.getByTestId('client-visibility-toggle-2');
    expect(visible.tagName).toBe('BUTTON');
    expect(visible).toHaveAttribute('aria-label', 'Visible to guests');
    expect(visible).toHaveAttribute('aria-pressed', 'false');
    expect(hidden).toHaveAttribute('aria-label', 'Hidden from guests');
    expect(hidden).toHaveAttribute('aria-pressed', 'true');
    // Same top-left corner as Grid; the selection checkbox owns top-right.
    expect(visible.className).toContain('top-2 left-2');
  });

  it('dims the hidden photo only', () => {
    mount(<Layout {...baseProps({ isClient: true, onToggleVisibility: vi.fn() })} />);
    const dimmed = (id: number) => {
      const img = screen.getByAltText(`IMG_${id}.jpg`);
      const el = dims === 'tile' ? screen.getByTestId(`client-visibility-toggle-${id}`).parentElement! : img;
      return el.className.split(/\s+/).includes('opacity-40');
    };
    expect(dimmed(2)).toBe(true);
    expect(dimmed(1)).toBe(false);
  });

  it('toggles without opening the photo', () => {
    const onToggleVisibility = vi.fn();
    const props = baseProps({ isClient: true, onToggleVisibility }) as unknown as { onPhotoClick: ReturnType<typeof vi.fn> };
    mount(<Layout {...(props as never)} />);

    fireEvent.click(screen.getByTestId('client-visibility-toggle-2'));
    expect(onToggleVisibility).toHaveBeenCalledWith(2, 'hidden');
    fireEvent.click(screen.getByTestId('client-visibility-toggle-1'));
    expect(onToggleVisibility).toHaveBeenCalledWith(1, 'visible');
    expect(props.onPhotoClick).not.toHaveBeenCalled();
  });

  it('shows no toggle and dims nothing for a guest', () => {
    mount(<Layout {...baseProps({ isClient: false, onToggleVisibility: vi.fn() })} />);
    expect(screen.queryByTestId('client-visibility-toggle-1')).toBeNull();
    expect(screen.queryByTestId('client-visibility-toggle-2')).toBeNull();
    expect(screen.getByAltText('IMG_2.jpg').className).not.toContain('opacity-40');
  });
});

describe('Masonry: count chips step aside for the toggle', () => {
  it('moves the top-left feedback counts right of the eye', () => {
    theme.gallerySettings = { masonryMode: 'columns' };
    const withCounts = photos.map((p) => ({ ...p, comment_count: 2 }));
    const { container } = mount(<MasonryGalleryLayout {...baseProps({
      photos: withCounts, feedbackEnabled: true, isClient: true, onToggleVisibility: vi.fn(),
    })} />);
    const chips = container.querySelectorAll('div.absolute.top-2.flex.gap-1');
    expect(chips.length).toBe(2);
    chips.forEach((chip) => expect(chip.className).toContain('left-11'));
  });
});

describe('Carousel: client visibility toggle (issue 1992)', () => {
  it('offers the toggle for the photo in view, in the top-left chip row', () => {
    const onToggleVisibility = vi.fn();
    const props = baseProps({ isClient: true, onToggleVisibility, photos: [photos[1], photos[0]] }) as unknown as {
      onPhotoClick: ReturnType<typeof vi.fn>;
    };
    mount(<CarouselGalleryLayout {...(props as never)} />);

    const toggle = screen.getByTestId('client-visibility-toggle-2');
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(within(toggle.parentElement!).getByText('1 / 2')).toBeInTheDocument();
    // The stage image (first, before the thumbnail strip) is dimmed.
    expect(screen.getAllByAltText('IMG_2.jpg')[0].className).toContain('opacity-40');

    fireEvent.click(toggle);
    expect(onToggleVisibility).toHaveBeenCalledWith(2, 'hidden');
    expect(props.onPhotoClick).not.toHaveBeenCalled();
  });

  it('shows no toggle for a guest', () => {
    mount(<CarouselGalleryLayout {...baseProps({ isClient: false, onToggleVisibility: vi.fn() })} />);
    expect(screen.queryByTestId('client-visibility-toggle-1')).toBeNull();
  });
});
