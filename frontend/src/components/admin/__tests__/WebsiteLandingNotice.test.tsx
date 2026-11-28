/**
 * After the update that moved the landing page into the website builder
 * (issue 2618), each admin of such an install is told once where it went.
 */
import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, fb?: unknown) => (typeof fb === 'string' ? fb : k) }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));
let enabled = true;
let canView = true;
vi.mock('../../../contexts/FeatureFlagsContext', () => ({ useFeatureEnabled: () => enabled }));
vi.mock('../../../contexts/PermissionsContext', () => ({ usePermissions: () => ({ hasPermission: () => canView }) }));
vi.mock('../../../services/website.service', () => ({
  websiteService: { getNotice: vi.fn(), dismissNotice: vi.fn() },
}));

import { websiteService } from '../../../services/website.service';
import WebsiteLandingNotice from '../WebsiteLandingNotice';

const renderNotice = (path = '/admin/dashboard') => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter initialEntries={[path]}><WebsiteLandingNotice /></MemoryRouter>
  </QueryClientProvider>,
);

describe('website landing notice', () => {
  beforeEach(() => { vi.clearAllMocks(); enabled = true; canView = true; });

  it('says where the landing page went, links to the builder, and goes away when dismissed', async () => {
    vi.mocked(websiteService.getNotice).mockResolvedValue({ legacyLanding: true });
    vi.mocked(websiteService.dismissNotice).mockResolvedValue(undefined);
    renderNotice();
    expect(await screen.findByText(/landing page now lives under Website/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Website' })).toHaveAttribute('href', '/admin/website');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(websiteService.dismissNotice).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText(/landing page now lives under Website/)).toBeNull());
  });

  it('leaves the Website page to its own banner, which says the same', async () => {
    vi.mocked(websiteService.getNotice).mockResolvedValue({ legacyLanding: true });
    renderNotice('/admin/website');
    await waitFor(() => expect(websiteService.getNotice).toHaveBeenCalled());
    expect(screen.queryByText(/landing page now lives under Website/)).toBeNull();
  });

  it('stays silent when there is nothing to say, the feature is off, or the admin cannot open the website', async () => {
    vi.mocked(websiteService.getNotice).mockResolvedValue({ legacyLanding: false });
    const { unmount } = renderNotice();
    await waitFor(() => expect(websiteService.getNotice).toHaveBeenCalled());
    expect(screen.queryByText(/landing page now lives under Website/)).toBeNull();
    unmount();
    enabled = false;
    renderNotice();
    canView = false;
    expect(websiteService.getNotice).toHaveBeenCalledTimes(1);
  });
});
