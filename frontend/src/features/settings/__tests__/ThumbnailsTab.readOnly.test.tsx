/**
 * Thumbnail settings are instance-wide and the regenerate buttons rebuild the
 * whole library, so the server requires settings.edit for both. An admin
 * without it sees the values read-only, with a note, instead of controls that
 * can only answer 403.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));
vi.mock('react-toastify', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../../../config/api', () => ({
  api: {
    get: vi.fn().mockResolvedValue({ data: { settings: {}, fitOptions: ['cover'], formatOptions: ['jpeg'] } }),
    put: vi.fn(),
    post: vi.fn(),
  },
}));
vi.mock('../../../hooks/usePermission', () => ({ usePermission: vi.fn() }));

import { ThumbnailsTab } from '../tabs/ThumbnailsTab';
import { usePermission } from '../../../hooks/usePermission';

function renderTab() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ThumbnailsTab />
    </QueryClientProvider>,
  );
}

describe('ThumbnailsTab permissions', () => {
  beforeEach(() => {
    vi.mocked(usePermission).mockReset();
  });

  it('is read-only with a note for an admin without settings.edit', async () => {
    vi.mocked(usePermission).mockReturnValue(false);
    renderTab();

    expect(await screen.findByText('settings.thumbnails.readOnly')).toBeInTheDocument();
    expect(screen.getByText('settings.thumbnails.regenerateButton').closest('button')).toBeDisabled();
    expect(screen.getAllByRole('spinbutton')[0]).toBeDisabled();
    expect(usePermission).toHaveBeenCalledWith('settings.edit');
  });

  it('keeps the controls for an admin with settings.edit', async () => {
    vi.mocked(usePermission).mockReturnValue(true);
    renderTab();

    expect(await screen.findByText('settings.thumbnails.regenerateButton')).toBeInTheDocument();
    expect(screen.queryByText('settings.thumbnails.readOnly')).toBeNull();
    expect(screen.getByText('settings.thumbnails.regenerateButton').closest('button')).not.toBeDisabled();
  });
});
