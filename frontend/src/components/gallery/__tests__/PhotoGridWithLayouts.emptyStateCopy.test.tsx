/**
 * The filename list (issue 1733, A3d) is event-wide: when a search or feedback
 * filter leaves no photo on screen, the classic grid's empty state must still
 * offer the Copy filenames action instead of returning before it.
 */
import { fireEvent, render, screen } from '@testing-library/react';
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
  it('keeps the Copy filenames action next to the empty message', () => {
    const onCopyFilenames = vi.fn();
    renderGrid({ onCopyFilenames, copyFilenamesCount: 4 });

    expect(screen.getByText('gallery.noPhotosFound')).toBeInTheDocument();
    const button = screen.getByRole('button', { name: /Copy filenames \(4\)/ });
    fireEvent.click(button);
    expect(onCopyFilenames).toHaveBeenCalledTimes(1);
  });

  it('shows no action when there is nothing to copy', () => {
    renderGrid({ onCopyFilenames: vi.fn(), copyFilenamesCount: 0 });
    expect(screen.getByText('gallery.noPhotosFound')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Copy filenames/ })).not.toBeInTheDocument();
  });
});
