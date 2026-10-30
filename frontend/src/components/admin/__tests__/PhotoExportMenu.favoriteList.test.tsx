/**
 * "Show in photos" from the guest detail opens the Photos tab filtered to one
 * favourite list (issue 2303). That filter must count as an applied filter,
 * or the export stays locked behind "Select photos or apply filters".
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useTranslation: () => ({ t: (k: string, d?: unknown) => (typeof d === 'string' ? d : k) }),
}));

import { PhotoExportMenu } from '../PhotoExportMenu';

const renderMenu = (filters: Record<string, unknown>) => render(
  <QueryClientProvider client={new QueryClient()}>
    <PhotoExportMenu eventId={1} selectedPhotoIds={[]} filters={filters as never} />
  </QueryClientProvider>,
);

describe('PhotoExportMenu with a favourite-list filter', () => {
  it('is enabled for a list filter alone', () => {
    renderMenu({ minRating: null, favoriteList: 5 });
    expect(screen.getAllByRole('button')[0]).not.toBeDisabled();
  });

  it('is enabled for the default list of one guest', () => {
    renderMenu({ minRating: null, favoriteList: 'default', favoriteGuest: 3 });
    expect(screen.getAllByRole('button')[0]).not.toBeDisabled();
  });

  it('stays locked without a selection or any filter', () => {
    renderMenu({ minRating: null });
    expect(screen.getAllByRole('button')[0]).toBeDisabled();
  });
});
