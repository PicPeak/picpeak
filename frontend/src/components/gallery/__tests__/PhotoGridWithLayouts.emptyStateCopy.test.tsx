/**
 * The classic grid's empty state: which message it shows. The filename list
 * (issue 1733, A3d) is event-wide and stays reachable when a search or filter
 * leaves no photo on screen, from the gallery toolbar above the grid (issue
 * 1733, E8), so the empty state no longer carries its own copy of it.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { PhotoGridWithLayouts } from '../PhotoGridWithLayouts';

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
  return { ...actual, useTheme: () => ({ theme: { galleryLayout: 'grid' } }) };
});

vi.mock('../../../hooks/useGallery', () => ({
  useDownloadPhoto: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
}));

const renderGrid = (props: Partial<React.ComponentProps<typeof PhotoGridWithLayouts>>) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <PhotoGridWithLayouts photos={[]} slug="demo" {...props} />
      </MemoryRouter>
    </QueryClientProvider>
  );
};

describe('PhotoGridWithLayouts empty state — filename list', () => {
  it('leaves the Copy filenames action to the gallery toolbar', () => {
    renderGrid({ onCopyFilenames: vi.fn(), copyFilenamesCount: 4 });
    expect(screen.getByText('There are no photos here yet.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Copy filenames/ })).not.toBeInTheDocument();
  });

  it('says the gallery is empty only when no search or filter is hiding photos', () => {
    const { unmount } = renderGrid({ emptyIsFiltered: false });
    expect(screen.getByText('There are no photos here yet.')).toBeInTheDocument();
    expect(screen.queryByText('No photos match your search or filters.')).not.toBeInTheDocument();
    unmount();
    renderGrid({ emptyIsFiltered: true });
    expect(screen.getByText('No photos match your search or filters.')).toBeInTheDocument();
  });
});
