/**
 * Issue 1992: in Client Access Mode the per-photo hide/show (eye) button was
 * rendered by Grid only. Every tile layout must offer it, show the hidden
 * state (crossed-out eye, dimmed photo), and keep the click away from the
 * tile underneath, which would open the lightbox. Only the image is dimmed,
 * so the eye stays at full strength, and the colour-label dot steps right of
 * the eye instead of sitting under it.
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
vi.mock('../../../../services/feedback.service', async (importOriginal) => ({
  // The real swatches: the colour-label dot renders from them.
  ...(await importOriginal<typeof import('../../../../services/feedback.service')>()),
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
};

const cases: LayoutCase[] = [
  { name: 'Grid', Layout: GridGalleryLayout as React.FC<never> },
  { name: 'Masonry columns', Layout: MasonryGalleryLayout as React.FC<never>, settings: { masonryMode: 'columns' } },
  { name: 'Masonry rows', Layout: MasonryGalleryLayout as React.FC<never>, settings: { masonryMode: 'rows' } },
  { name: 'Masonry justified', Layout: MasonryGalleryLayout as React.FC<never>, settings: { masonryMode: 'justified' } },
  { name: 'Masonry flickr', Layout: MasonryGalleryLayout as React.FC<never>, settings: { masonryMode: 'flickr' } },
  { name: 'Masonry quilted', Layout: MasonryGalleryLayout as React.FC<never>, settings: { masonryMode: 'quilted' } },
  { name: 'Mosaic', Layout: MosaicGalleryLayout as React.FC<never> },
  { name: 'Timeline', Layout: TimelineGalleryLayout as React.FC<never> },
];

const hasClass = (el: Element, cls: string) => el.className.split(/\s+/).includes(cls);
const dimmedAncestors = (el: HTMLElement) => {
  const found: HTMLElement[] = [];
  for (let node = el.parentElement; node; node = node.parentElement) {
    if (hasClass(node, 'opacity-40')) found.push(node);
  }
  return found;
};
const labelled = photos.map((p) => ({ ...p, my_color_label: 'red' }));
const dotOf = (container: HTMLElement, id: number) =>
  container.querySelector(`[data-testid="client-visibility-toggle-${id}"]`)
    ?.closest('div.flex')?.querySelector('[aria-label^="Marked as"]') as HTMLElement | null;

describe.each(cases)('$name: client visibility toggle (issue 1992)', ({ Layout, settings }) => {
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
    // Top-left corner row, as in Grid; the selection checkbox owns top-right.
    expect(visible.parentElement!.className).toContain('absolute top-2 left-2');
  });

  it('dims the image of the hidden photo only, never the eye', () => {
    mount(<Layout {...baseProps({ isClient: true, onToggleVisibility: vi.fn() })} />);
    expect(hasClass(screen.getByAltText('IMG_2.jpg'), 'opacity-40')).toBe(true);
    expect(hasClass(screen.getByAltText('IMG_1.jpg'), 'opacity-40')).toBe(false);
    // Grid used to dim the whole tile, the eye with it.
    expect(dimmedAncestors(screen.getByTestId('client-visibility-toggle-2'))).toEqual([]);
  });

  it('puts the colour-label dot right of the eye, in its row', () => {
    const { container } = mount(<Layout {...baseProps({
      photos: labelled, isClient: true, onToggleVisibility: vi.fn(),
    })} />);
    const toggle = screen.getByTestId('client-visibility-toggle-1');
    const dot = dotOf(container, 1)!;
    expect(dot).not.toBeNull();
    const dotRow = dot.parentElement!;
    // The dot row is in the toggle's row, after it, and not positioned itself.
    expect(dotRow.parentElement).toBe(toggle.parentElement);
    expect(toggle.compareDocumentPosition(dotRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(hasClass(dotRow, 'absolute')).toBe(false);
    // The tile's colour ring still renders.
    expect(container.querySelectorAll('span.absolute.inset-0[aria-hidden="true"]').length).toBe(labelled.length);
  });

  it('leaves the dot in the corner when there is no toggle', () => {
    const { container } = mount(<Layout {...baseProps({ photos: labelled, isClient: false })} />);
    const dots = container.querySelectorAll('[aria-label^="Marked as"]');
    expect(dots.length).toBe(labelled.length);
    dots.forEach((dot) => expect(dot.parentElement!.className).toContain('absolute top-2 left-2'));
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

describe.each(['columns', 'rows', 'flickr', 'quilted'])('Masonry %s: count chips share the eye row', (masonryMode) => {
  const withCounts = labelled.map((p) => ({ ...p, comment_count: 2 }));
  const chipsOf = (container: HTMLElement) =>
    Array.from(container.querySelectorAll('svg.lucide-message-square'), (icon) => icon.closest('div.rounded-full')!.parentElement as HTMLElement);

  beforeEach(() => {
    theme.gallerySettings = { masonryMode };
  });

  it('lines up eye, dot and counts in one row, in that order', () => {
    const { container } = mount(<MasonryGalleryLayout {...baseProps({
      photos: withCounts, feedbackEnabled: true, isClient: true, onToggleVisibility: vi.fn(),
    })} />);
    const chips = chipsOf(container);
    expect(chips.length).toBe(2);
    chips.forEach((chip) => expect(hasClass(chip, 'absolute')).toBe(false));
    const toggle = screen.getByTestId('client-visibility-toggle-1');
    const row = toggle.parentElement!;
    const dotRow = dotOf(container, 1)!.parentElement!;
    const chipRow = chips.find((chip) => chip.parentElement === row)!;
    expect(Array.from(row.children)).toEqual([toggle, dotRow, chipRow]);
  });

  it('keeps the counts in the corner for a guest', () => {
    const { container } = mount(<MasonryGalleryLayout {...baseProps({
      photos: withCounts, feedbackEnabled: true, isClient: false,
    })} />);
    const chips = chipsOf(container);
    expect(chips.length).toBe(2);
    chips.forEach((chip) => expect(chip.className).toContain('absolute top-2 left-2'));
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
    // The stage image (first) and its thumbnail in the strip are dimmed;
    // the visible photo's thumbnail is not.
    const [stage, thumb] = screen.getAllByAltText('IMG_2.jpg');
    expect(stage.className).toContain('opacity-40');
    expect(thumb.className).toContain('opacity-40');
    expect(screen.getByAltText('IMG_1.jpg').className).not.toContain('opacity-40');

    fireEvent.click(toggle);
    expect(onToggleVisibility).toHaveBeenCalledWith(2, 'hidden');
    expect(props.onPhotoClick).not.toHaveBeenCalled();
  });

  it('shows no toggle for a guest, and dims nothing', () => {
    mount(<CarouselGalleryLayout {...baseProps({ isClient: false, onToggleVisibility: vi.fn(), photos: [photos[1], photos[0]] })} />);
    expect(screen.queryByTestId('client-visibility-toggle-1')).toBeNull();
    screen.getAllByAltText('IMG_2.jpg').forEach((img) => expect(img.className).not.toContain('opacity-40'));
  });
});
