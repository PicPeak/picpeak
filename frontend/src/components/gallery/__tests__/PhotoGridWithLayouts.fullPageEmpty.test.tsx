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
});
