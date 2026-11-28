/**
 * The website's traffic (issue 2618) in the Analytics page: page views per
 * day, the most viewed pages, where visitors came from and their devices.
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, fb?: unknown) => (typeof fb === 'string' ? fb : k) }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));
vi.mock('../../../../services/website.service', () => ({
  websiteService: {
    getAnalytics: vi.fn().mockResolvedValue({
      chartData: [{ date: '2026-11-26', views: 1 }, { date: '2026-11-27', views: 9 }],
      topPages: [{ page: '', title: 'Home', views: 7 }, { page: 'about', title: 'About', views: 3 }],
      referrers: [{ domain: 'instagram.com', views: 6 }],
      devices: { desktop: 40, mobile: 60, tablet: 0 },
      totals: { views: 10 },
    }),
  },
}));

import { websiteService } from '../../../../services/website.service';
import { WebsiteTrafficSection } from '../WebsiteTrafficSection';

describe('website traffic section', () => {
  it('shows views, top pages, referrers and devices for the chosen days', async () => {
    render(<QueryClientProvider client={new QueryClient()}><WebsiteTrafficSection days={30} /></QueryClientProvider>);
    expect(await screen.findByText('10')).toBeInTheDocument();
    expect(websiteService.getAnalytics).toHaveBeenCalledWith(30);
    expect(screen.getByText('Home')).toBeInTheDocument();
    expect(screen.getByText('/about')).toBeInTheDocument();
    expect(screen.getByText('instagram.com')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('60%')).toBeInTheDocument());
    expect(screen.getByText(/counted on the server/)).toBeInTheDocument();
  });
});
