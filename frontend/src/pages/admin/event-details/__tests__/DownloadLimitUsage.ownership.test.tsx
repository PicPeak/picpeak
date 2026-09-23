/**
 * Download limit (issue 1560): Reset needs event ownership as well as
 * events.edit. An admin who sees another owner's event (the payload's
 * share_secrets_hidden) gets the usage but no Reset, which would only 403.
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
vi.mock('../../../../hooks/usePermission', () => ({ usePermission: () => true }));
vi.mock('../../../../services/events.service', () => ({
  eventsService: {
    getDownloadLimitUsage: vi.fn(),
    resetDownloadLimitUsage: vi.fn(),
  },
}));

import { eventsService } from '../../../../services/events.service';
import { DownloadLimitUsage } from '../DownloadLimitUsage';

function renderUsage(ownedByOther?: boolean) {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <DownloadLimitUsage eventId={3} downloadLimit={10} ownedByOther={ownedByOther} />
    </QueryClientProvider>,
  );
}

describe('DownloadLimitUsage Reset and event ownership', () => {
  beforeEach(() => {
    vi.mocked(eventsService.getDownloadLimitUsage).mockResolvedValue({
      download_limit: 10, downloads_used: 4, downloads_remaining: 6,
    });
  });

  it('offers Reset to the owner', async () => {
    renderUsage(false);
    expect(await screen.findByText('events.downloadLimitReset')).toBeInTheDocument();
  });

  it("shows the usage but no Reset on another owner's event", async () => {
    renderUsage(true);
    expect(await screen.findByText('events.downloadLimitUsage')).toBeInTheDocument();
    await vi.waitFor(() => expect(eventsService.getDownloadLimitUsage).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText('events.downloadLimitReset')).toBeNull();
  });
});
