/**
 * Download limit (issue 1560): a refused Reset shows the server's reason
 * (403 not your event, 404 gone), with the fixed text only as the fallback.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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

import { toast } from 'react-toastify';
import { eventsService } from '../../../../services/events.service';
import { DownloadLimitUsage } from '../DownloadLimitUsage';

async function clickReset() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <DownloadLimitUsage eventId={3} downloadLimit={10} />
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByText('events.downloadLimitReset'));
}

describe('DownloadLimitUsage reset errors', () => {
  beforeEach(() => {
    vi.mocked(toast.error).mockReset();
    vi.mocked(eventsService.getDownloadLimitUsage).mockResolvedValue({
      download_limit: 10, downloads_used: 4, downloads_remaining: 6,
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  it("shows the server's message", async () => {
    vi.mocked(eventsService.resetDownloadLimitUsage).mockRejectedValue({
      response: { status: 403, data: { error: 'Access denied to this event' } },
    });
    await clickReset();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Access denied to this event'));
  });

  it('falls back to the fixed text when the server gives none', async () => {
    vi.mocked(eventsService.resetDownloadLimitUsage).mockRejectedValue({ response: { status: 500, data: {} } });
    await clickReset();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('events.downloadLimitResetFailed'));
  });
});
