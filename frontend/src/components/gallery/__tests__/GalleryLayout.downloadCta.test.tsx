/**
 * The download CTA must survive every header style.
 *
 * `showDownloadAll` (the old primary "Download all" button) is hard-wired to
 * false by GalleryView — the live entry point is `showHeaderDownload`, the
 * accent CTA that opens the resolution picker. That CTA was rendered in the
 * standard, minimal and hero headers but not in `headerStyle: 'none'`, whose
 * comment claimed the variant was "fully chromeless by design" — it is not: it
 * still renders the menu, headerExtra and logout. So `none` silently dropped
 * the gallery's primary download affordance, leaving guests with per-tile
 * downloads and the selection-mode bulk button only (QA P4-B.05).
 *
 * 'none' means "no title header", not "no downloads".
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { HeaderStyleType } from '../../../types/theme.types';

import { GalleryLayout } from '../GalleryLayout';

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
  return { ...actual, useTheme: () => ({ theme: {} }) };
});

vi.mock('../../../services/cms.service', () => ({
  cmsService: { getPublicPage: vi.fn().mockRejectedValue(new Error('no cms')) },
}));

const renderLayout = (headerStyle: HeaderStyleType) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <GalleryLayout
          event={{ event_name: 'ZZTEST Wedding' }}
          headerStyle={headerStyle}
          showDownloadAll={false}
          onDownloadAll={vi.fn()}
          showHeaderDownload
          onHeaderDownload={vi.fn()}
          showLogout
          onLogout={vi.fn()}
        >
          <div>photos</div>
        </GalleryLayout>
      </MemoryRouter>
    </QueryClientProvider>
  );
};

describe('GalleryLayout header download CTA', () => {
  it.each<HeaderStyleType>(['standard', 'minimal', 'hero', 'none', 'banner'])(
    'renders the download CTA with headerStyle "%s"',
    (headerStyle) => {
      const { unmount } = renderLayout(headerStyle);
      expect(screen.getAllByRole('button', { name: 'Download' }).length).toBeGreaterThan(0);
      unmount();
    }
  );

  it('omits the CTA when the gallery does not allow downloads', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <GalleryLayout
            event={{ event_name: 'ZZTEST Wedding' }}
            headerStyle="none"
            showDownloadAll={false}
            showHeaderDownload={false}
            showLogout
            onLogout={vi.fn()}
          >
            <div>photos</div>
          </GalleryLayout>
        </MemoryRouter>
      </QueryClientProvider>
    );
    expect(screen.queryByRole('button', { name: 'Download' })).not.toBeInTheDocument();
  });
});
