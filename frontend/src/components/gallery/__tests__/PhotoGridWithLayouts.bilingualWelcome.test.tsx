/**
 * Bilingual welcome message (issue 2550): the box shows when either language
 * has text, so a welcome written only in the second language is not dropped.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { PhotoGridWithLayouts } from '../PhotoGridWithLayouts';
import { GallerySecondaryTextProvider } from '../../../hooks/useGalleryText';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return { ...actual, useTranslation: () => ({ t: (key: string, second?: unknown) => (typeof second === 'string' ? second : key), i18n: { language: 'en' } }) };
});
vi.mock('../../../contexts/ThemeContext', async () => {
  const actual = await vi.importActual<typeof import('../../../contexts/ThemeContext')>('../../../contexts/ThemeContext');
  return { ...actual, useTheme: () => ({ theme: { galleryLayout: 'grid' } }) };
});
vi.mock('../../../hooks/useGallery', () => ({
  useDownloadPhoto: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
}));

// The grid observes its tiles; jsdom has no IntersectionObserver.
vi.stubGlobal('IntersectionObserver', class {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() { return []; }
});

const renderGrid = (welcomeMessage: string | undefined, secondary: string | null) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <GallerySecondaryTextProvider value={{ title: null, welcome: secondary }}>
          <PhotoGridWithLayouts photos={[{ id: 1, filename: 'a.jpg', url: '/a.jpg', thumbnail_url: '/a.jpg', type: 'individual', size: 1, uploaded_at: '2026-08-01T00:00:00Z' } as never]} slug="demo" welcomeMessage={welcomeMessage} />
        </GallerySecondaryTextProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
};

afterEach(cleanup);

describe('PhotoGridWithLayouts bilingual welcome', () => {
  it('shows a welcome written only in the second language', () => {
    renderGrid(undefined, 'Welcome');
    expect(screen.getByText('Welcome')).toBeInTheDocument();
  });

  it('shows both lines, and nothing without either', () => {
    const { unmount, container } = renderGrid('Willkommen', 'Welcome');
    expect(container.textContent).toContain('Willkommen');
    expect(container.textContent).toContain('Welcome');
    unmount();
    const empty = renderGrid(undefined, null);
    expect(empty.container.querySelector('[data-gallery-text="secondary"]')).toBeNull();
    expect(empty.container.querySelector('.whitespace-pre-line')).toBeNull();
  });
});
