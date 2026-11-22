/**
 * Bilingual gallery title (issue 2550): every GalleryLayout header draws the
 * secondary language next to the title when GalleryView hands one down, and
 * nothing extra without it.
 */
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { GalleryLayout } from '../GalleryLayout';
import { GallerySecondaryTextProvider } from '../../../hooks/useGalleryText';
import type { HeaderStyleType } from '../../../types/theme.types';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string, second?: unknown) => (typeof second === 'string' ? second : key), i18n: { language: 'en' } }),
  };
});
vi.mock('../../../contexts/ThemeContext', async () => {
  const actual = await vi.importActual<typeof import('../../../contexts/ThemeContext')>('../../../contexts/ThemeContext');
  return { ...actual, useTheme: () => ({ theme: {} }) };
});
vi.mock('../../../services/cms.service', () => ({
  cmsService: { getPublicPage: vi.fn().mockRejectedValue(new Error('no cms')) },
}));
vi.mock('../../../contexts/GuestIdentityContext', () => ({ useGuestIdentityOptional: () => null }));

function renderHeader(headerStyle: HeaderStyleType, secondary: string | null) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <GallerySecondaryTextProvider value={{ title: secondary, welcome: null }}>
          <GalleryLayout event={{ event_name: 'Hochzeit Anna & Ben' }} headerStyle={headerStyle}>
            <div>photos</div>
          </GalleryLayout>
        </GallerySecondaryTextProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(cleanup);

describe.each(['standard', 'minimal', 'banner'] as HeaderStyleType[])('the %s header', (style) => {
  it('shows the secondary language with the title', () => {
    const { container } = renderHeader(style, 'Wedding Anna & Ben');
    const secondary = [...container.querySelectorAll('[data-gallery-text="secondary"]')];
    expect(secondary.length).toBeGreaterThan(0);
    expect(secondary.every((el) => el.textContent?.includes('Wedding Anna & Ben'))).toBe(true);
    expect(container.textContent).toContain('Hochzeit Anna & Ben');
  });

  it('draws nothing extra without one', () => {
    const { container } = renderHeader(style, null);
    expect(container.querySelector('[data-gallery-text="secondary"]')).toBeNull();
  });
});
