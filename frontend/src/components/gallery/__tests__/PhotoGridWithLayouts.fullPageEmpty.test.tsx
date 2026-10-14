/**
 * Premium and Story render their own empty state, with the guest upload
 * button and the event-wide filename list. PhotoGridWithLayouts must hand an
 * empty list through to them instead of returning its own message first.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { PhotoGridWithLayouts } from '../PhotoGridWithLayouts';

const theme = vi.hoisted(() => ({ galleryLayout: 'gallery-premium' }));

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, second?: any) => (typeof second === 'string' ? second : key),
      i18n: { language: 'en' },
    }),
  };
});

vi.mock('../../../contexts/ThemeContext', async () => {
  const actual = await vi.importActual<typeof import('../../../contexts/ThemeContext')>(
    '../../../contexts/ThemeContext'
  );
  return { ...actual, useTheme: () => ({ theme }) };
});

vi.mock('../../../hooks/useGallery', () => ({
  useDownloadPhoto: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
}));

// The filled layouts observe their tiles; jsdom has no IntersectionObserver.
vi.stubGlobal('IntersectionObserver', class {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() { return []; }
});

const renderGrid = (props: Partial<React.ComponentProps<typeof PhotoGridWithLayouts>>) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = (p: typeof props) => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <PhotoGridWithLayouts photos={[]} slug="demo" {...p} />
      </MemoryRouter>
    </QueryClientProvider>
  );
  const view = render(tree(props));
  return { ...view, rerenderWith: (next: typeof props) => view.rerender(tree(next)) };
};

const photo = {
  id: 1, filename: 'a.jpg', url: '/api/gallery/demo/photo/1', thumbnail_url: '/api/gallery/demo/thumbnail/1',
  width: 600, height: 400, type: 'individual', size: 1, uploaded_at: '2026-01-01T00:00:00Z',
} as any;

describe.each(['gallery-premium', 'gallery-story'])('PhotoGridWithLayouts empty %s', (layout) => {
  beforeEach(() => {
    theme.galleryLayout = layout;
  });

  it('reaches the layout, whose empty state offers the upload button', () => {
    const onUploadClick = vi.fn();
    renderGrid({ onUploadClick });
    fireEvent.click(screen.getByRole('button', { name: /upload/i }));
    expect(onUploadClick).toHaveBeenCalledTimes(1);
  });

  it('keeps the Copy filenames action when a filter leaves nothing', () => {
    const onCopyFilenames = vi.fn();
    renderGrid({ onCopyFilenames, copyFilenamesCount: 3, emptyIsFiltered: true });
    fireEvent.click(screen.getByRole('button', { name: /Copy filenames \(3\)/ }));
    expect(onCopyFilenames).toHaveBeenCalledTimes(1);
  });

  it('hands focus to the new upload button when the first upload fills the gallery', () => {
    const onUploadClick = vi.fn();
    const { rerenderWith } = renderGrid({ onUploadClick });
    // The upload dialog returns focus to the empty state's button on close.
    screen.getByRole('button', { name: /upload/i }).focus();
    // The refetch brings the first photo: the layout remounts out of its
    // empty state and that button is gone.
    rerenderWith({ onUploadClick, photos: [photo] });
    const navUpload = screen.getByTestId(layout === 'gallery-premium' ? 'premium-nav-upload' : 'story-nav-upload');
    expect(document.activeElement).toBe(navUpload);
  });

  it('leaves focus alone when it was elsewhere', () => {
    const onUploadClick = vi.fn();
    const { rerenderWith } = renderGrid({ onUploadClick });
    rerenderWith({ onUploadClick, photos: [photo] });
    expect(document.activeElement).toBe(document.body);
  });

  it('offers the way back from an empty Liked view', () => {
    const onToggleLikedOnly = vi.fn();
    renderGrid({ likedOnly: true, onToggleLikedOnly });
    fireEvent.click(screen.getByRole('button', { name: 'Show all photos' }));
    expect(onToggleLikedOnly).toHaveBeenCalledTimes(1);
  });

  it('moves focus between the nav heart and "Show all photos" across the empty Liked view', () => {
    const likes = { feedbackEnabled: true, feedbackOptions: { allowLikes: true } as never };
    const { rerenderWith } = renderGrid({ ...likes, photos: [photo], onToggleLikedOnly: vi.fn() });
    const heartId = layout === 'gallery-premium' ? 'premium-nav-liked' : 'story-nav-liked';
    screen.getByTestId(heartId).focus();
    // Nothing liked: the filter empties the view and the layout remounts.
    rerenderWith({ ...likes, photos: [], likedOnly: true, onToggleLikedOnly: vi.fn() });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Show all photos' }));
    // And back.
    rerenderWith({ ...likes, photos: [photo], likedOnly: false, onToggleLikedOnly: vi.fn() });
    expect(document.activeElement).toBe(screen.getByTestId(heartId));
  });
});
