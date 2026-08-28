/**
 * Shift-click range selection in the admin photo grid (#1212).
 *
 * Reported in #1209 by someone re-assigning a category across a large imported
 * set: Select All is all-or-one, so "these two hundred" meant two hundred
 * clicks. The range extends the selection rather than replacing it, and it
 * only ever adds — a mis-aimed shift-click should grow the wrong set, not
 * destroy the right one.
 *
 * The case that matters most is the last one. The anchor is an index, and an
 * index means a different photo after a filter or a re-sort, so a range
 * measured from a stale anchor would select the wrong span with no sign that
 * anything went wrong.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';

import { AdminPhotoGrid } from '../AdminPhotoGrid';
import type { AdminPhoto } from '../../../services/photos.service';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({
      t: (_key: string, fallback?: any) => (typeof fallback === 'string' ? fallback : _key),
      i18n: { language: 'en' }
    })
  };
});

vi.mock('../AdminAuthenticatedImage', () => ({
  AdminAuthenticatedImage: ({ alt }: { alt: string }) => <img alt={alt} />
}));

vi.mock('../../../services/photos.service', () => ({
  photosService: { formatBytes: (n: number) => `${n} B` }
}));

vi.mock('../PermissionGate', () => ({
  PermissionGate: ({ children }: { children: ReactNode }) => <>{children}</>
}));

const photo = (id: number): AdminPhoto => ({
  id, filename: `p${id}.jpg`, path: `/p${id}.jpg`, url: `/p${id}.jpg`,
  thumbnail_url: `/t/p${id}.jpg`, type: 'photo',
  category_id: null, category_name: null, category_slug: null,
  size: 1000 + id, uploaded_at: '2026-01-01T00:00:00Z'
} as AdminPhoto);

const renderWithQueryClient = (ui: ReactElement) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
};

const renderGrid = (photos: AdminPhoto[]) => {
  const onSelectionChange = vi.fn();
  const view = renderWithQueryClient(
    <AdminPhotoGrid
      photos={photos}
      eventId={42}
      onPhotoClick={vi.fn()}
      onPhotosDeleted={vi.fn()}
      onSelectionChange={onSelectionChange}
    />
  );
  return { onSelectionChange, view };
};

const FIVE = [1, 2, 3, 4, 5].map(photo);

const selectedIds = (onSelectionChange: ReturnType<typeof vi.fn>) =>
  [...(onSelectionChange.mock.calls.at(-1)?.[0] ?? [])].sort((a: number, b: number) => a - b);

const checkbox = (id: number) => screen.getByTestId(`admin-photo-checkbox-${id}`);

describe('shift-click range selection (#1212)', () => {
  it('selects everything between the anchor and the shift-clicked tile', async () => {
    const user = userEvent.setup();
    const { onSelectionChange } = renderGrid(FIVE);

    await user.click(checkbox(2));
    await user.keyboard('{Shift>}');
    await user.click(checkbox(4));
    await user.keyboard('{/Shift}');

    expect(selectedIds(onSelectionChange)).toEqual([2, 3, 4]);
  });

  it('works when the range is drawn backwards', async () => {
    const user = userEvent.setup();
    const { onSelectionChange } = renderGrid(FIVE);

    await user.click(checkbox(4));
    await user.keyboard('{Shift>}');
    await user.click(checkbox(2));
    await user.keyboard('{/Shift}');

    expect(selectedIds(onSelectionChange)).toEqual([2, 3, 4]);
  });

  it('extends an existing selection rather than replacing it', async () => {
    const user = userEvent.setup();
    const { onSelectionChange } = renderGrid(FIVE);

    await user.click(checkbox(1));
    await user.click(checkbox(3));
    await user.keyboard('{Shift>}');
    await user.click(checkbox(5));
    await user.keyboard('{/Shift}');

    // 1 was picked before the range and stays picked.
    expect(selectedIds(onSelectionChange)).toEqual([1, 3, 4, 5]);
  });

  it('re-aims from the original anchor on a second shift-click', async () => {
    const user = userEvent.setup();
    const { onSelectionChange } = renderGrid(FIVE);

    await user.click(checkbox(1));
    await user.keyboard('{Shift>}');
    await user.click(checkbox(4));
    await user.click(checkbox(2));
    await user.keyboard('{/Shift}');

    // Still measured from 1. The anchor does not walk along behind the cursor,
    // so the second click narrows the intent rather than starting a new span
    // at 4 — though what it already added stays added.
    expect(selectedIds(onSelectionChange)).toEqual([1, 2, 3, 4]);
  });

  it('is a plain toggle when there is no anchor yet', async () => {
    const user = userEvent.setup();
    const { onSelectionChange } = renderGrid(FIVE);

    await user.keyboard('{Shift>}');
    await user.click(checkbox(3));
    await user.keyboard('{/Shift}');

    expect(selectedIds(onSelectionChange)).toEqual([3]);
  });

  it('leaves a plain click toggling one tile', async () => {
    const user = userEvent.setup();
    const { onSelectionChange } = renderGrid(FIVE);

    await user.click(checkbox(2));
    await user.click(checkbox(4));
    expect(selectedIds(onSelectionChange)).toEqual([2, 4]);

    await user.click(checkbox(2));
    expect(selectedIds(onSelectionChange)).toEqual([4]);
  });

  it('forgets the anchor when the selection is cleared', async () => {
    // The anchor is invisible. Left behind by Deselect All, it made the next
    // shift-click reach back into a selection session the user had already
    // ended — selecting a range they never started (#1212 review).
    const user = userEvent.setup();
    const { onSelectionChange } = renderGrid(FIVE);

    await user.click(checkbox(1));
    // Select All then again to deselect — with one tile picked the button is
    // still "Select All", so a single click would select rather than clear.
    await user.click(screen.getByRole('button', { name: /select all/i }));
    await user.click(screen.getByRole('button', { name: /deselect all/i }));
    expect(selectedIds(onSelectionChange)).toEqual([]);

    await user.keyboard('{Shift>}');
    await user.click(checkbox(4));
    await user.keyboard('{/Shift}');

    // A plain toggle of the tile that was clicked, not 1..4.
    expect(selectedIds(onSelectionChange)).toEqual([4]);
  });

  it('refuses to measure a range from an anchor the list has moved under', async () => {
    const user = userEvent.setup();
    const { onSelectionChange, view } = renderGrid(FIVE);

    // Anchor on the tile at index 1.
    await user.click(checkbox(2));

    // The list is re-filtered: index 1 is now a different photo entirely.
    view.rerender(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <AdminPhotoGrid
          photos={[photo(7), photo(8), photo(9)]}
          eventId={42}
          onPhotoClick={vi.fn()}
          onPhotosDeleted={vi.fn()}
          onSelectionChange={onSelectionChange}
        />
      </QueryClientProvider>
    );

    await user.keyboard('{Shift>}');
    await user.click(checkbox(9));
    await user.keyboard('{/Shift}');

    // Falls back to a plain toggle. Selecting one tile the user pointed at is
    // recoverable; silently selecting 7 and 8 as well is not.
    expect(selectedIds(onSelectionChange)).toEqual([2, 9]);
  });
});
