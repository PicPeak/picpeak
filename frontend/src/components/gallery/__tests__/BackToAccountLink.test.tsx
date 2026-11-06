/**
 * A gallery opened from the customer portal offers the way back to the
 * account, leftmost in the bar of every header style and of the full-page
 * layouts, which have their own nav; without the flag there is none.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { HeaderStyleType } from '../../../types/theme.types';

import { GalleryLayout } from '../GalleryLayout';
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

vi.mock('../../../services/cms.service', () => ({
  cmsService: { getPublicPage: vi.fn().mockRejectedValue(new Error('no cms')) },
}));

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

const wrap = (ui: React.ReactNode) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
};

const photo = {
  id: 1, filename: 'a.jpg', url: '/api/gallery/demo/photo/1', thumbnail_url: '/api/gallery/demo/thumbnail/1',
  width: 600, height: 400, type: 'individual', size: 1, uploaded_at: '2026-01-01T00:00:00Z',
} as any;

afterEach(cleanup);

describe.each<HeaderStyleType>(['standard', 'minimal', 'none', 'hero'])('GalleryLayout %s header', (headerStyle) => {
  const renderLayout = (showBackToAccount?: boolean) => wrap(
    <GalleryLayout event={{ event_name: 'ZZTEST Wedding' }} headerStyle={headerStyle} showBackToAccount={showBackToAccount}>
      <div>photos</div>
    </GalleryLayout>,
  );

  it('links back to the customer account', () => {
    renderLayout(true);
    const link = screen.getByRole('link', { name: 'Back to your account' });
    expect(link).toHaveAttribute('href', '/customer/dashboard');
    expect(link.closest('header')).not.toBeNull();
  });

  it('has no such link without the flag', () => {
    renderLayout();
    expect(screen.queryByTestId('gallery-back-to-account')).not.toBeInTheDocument();
  });
});

describe.each(['gallery-premium', 'gallery-story'])('%s nav', (layout) => {
  it('links back to the customer account', () => {
    theme.galleryLayout = layout;
    wrap(<PhotoGridWithLayouts photos={[photo]} slug="demo" showBackToAccount />);
    expect(screen.getByRole('link', { name: 'Back to your account' })).toHaveAttribute('href', '/customer/dashboard');
  });

  it('keeps the link when there are no photos to show', () => {
    theme.galleryLayout = layout;
    wrap(<PhotoGridWithLayouts photos={[]} slug="demo" showBackToAccount />);
    expect(screen.getByRole('link', { name: 'Back to your account' })).toHaveAttribute('href', '/customer/dashboard');
  });

  it('has no such link without the flag', () => {
    theme.galleryLayout = layout;
    wrap(<PhotoGridWithLayouts photos={[photo]} slug="demo" />);
    expect(screen.queryByTestId('gallery-back-to-account')).not.toBeInTheDocument();
  });
});
