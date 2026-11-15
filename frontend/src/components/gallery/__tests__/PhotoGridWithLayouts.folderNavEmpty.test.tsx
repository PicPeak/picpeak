/**
 * The folder navigation renders below the hero as `afterHero` (issue 2504).
 * A search or filter that leaves no photo returns the empty message early;
 * the navigation must stay, or the way into the other folders is gone.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { PhotoGridWithLayouts } from '../PhotoGridWithLayouts';

vi.mock('react-i18next', async () => ({
  ...(await vi.importActual<typeof import('react-i18next')>('react-i18next')),
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('../../../contexts/ThemeContext', async () => ({
  ...(await vi.importActual<typeof import('../../../contexts/ThemeContext')>('../../../contexts/ThemeContext')),
  useTheme: () => ({ theme: { galleryLayout: 'grid' } }),
}));
vi.mock('../../../hooks/useGallery', () => ({
  useDownloadPhoto: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
}));

describe('PhotoGridWithLayouts with no photos', () => {
  it('keeps the folder navigation above the empty message', () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <PhotoGridWithLayouts photos={[]} slug="demo" afterHero={<nav aria-label="folders">Ceremony</nav>} />
      </QueryClientProvider>,
    );
    const nav = screen.getByRole('navigation', { name: 'folders' });
    const message = screen.getByText('gallery.noPhotosFound');
    expect(nav.compareDocumentPosition(message) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
