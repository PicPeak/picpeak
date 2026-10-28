import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const { getDashboard, getEventOverview, getEventAccessToken, notify } = vi.hoisted(() => ({
  getDashboard: vi.fn(), getEventOverview: vi.fn(), getEventAccessToken: vi.fn(), notify: vi.fn(),
}));
vi.mock('../../../services/customer.service', () => ({ customerService: { getDashboard, getEventOverview, getEventAccessToken } }));
vi.mock('react-toastify', () => ({ toast: { error: notify } }));
vi.mock('../../../hooks/useLocalizedDate', () => ({ useLocalizedDate: () => ({ format: (value: string) => value, formatExpiry: (value: string) => value }) }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback?: string) => fallback || _key }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

import { CustomerDashboardPage } from '../CustomerDashboardPage';
import { CustomerEventPage } from '../CustomerEventPage';

const event = { id: 7, slug: 'wedding', eventName: 'Wedding', eventType: 'wedding', eventDate: null,
  expiresAt: null, isActive: true, assignedAt: null, availability: 'paused' };
const emptyItems = { quotes: [], contracts: [], contractDetails: [], invoices: [], documents: [], documentRequests: [] };
const mount = (page: 'dashboard' | 'event') => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/customer/events/wedding']}>
    <Routes><Route path="/customer/events/:slug" element={page === 'dashboard' ? <CustomerDashboardPage /> : <CustomerEventPage />} /></Routes>
  </MemoryRouter></QueryClientProvider>);
};

describe('customer portal gallery pauses', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getDashboard.mockResolvedValue({ needsAction: emptyItems, recent: [], galleries: { active: [event], expired: [] } });
    getEventOverview.mockResolvedValue({ event, sections: {}, quotes: [], contracts: [], invoices: [], documents: [] });
  });

  it.each(['dashboard', 'event'] as const)('explains a pause on the %s without offering access or calling it unpublished', async (page) => {
    mount(page);
    expect(await screen.findByText('This gallery is temporarily unavailable.')).toBeInTheDocument();
    expect(screen.queryByText(/not available yet/i)).toBeNull();
    expect(getEventAccessToken).not.toHaveBeenCalled();
    if (page === 'dashboard') expect(screen.getByRole('button', { name: /Open/ })).toBeDisabled();
    else expect(screen.queryByRole('button', { name: 'Open gallery' })).toBeNull();
  });

  it.each(['dashboard', 'event'] as const)('explains a pause that starts after the %s loads instead of claiming access was revoked', async (page) => {
    getDashboard.mockResolvedValue({ needsAction: emptyItems, recent: [], galleries: { active: [{ ...event, availability: 'active' }], expired: [] } });
    getEventOverview.mockResolvedValue({ event: { ...event, availability: 'active' }, sections: {}, quotes: [], contracts: [], invoices: [], documents: [] });
    getEventAccessToken.mockRejectedValue({ response: { status: 403, data: { code: 'GALLERY_TEMPORARILY_DISABLED' } } });
    mount(page);
    fireEvent.click(await screen.findByRole('button', { name: /Open/ }));
    await waitFor(() => expect(notify).toHaveBeenCalledWith('This gallery is temporarily unavailable.'));
    expect(notify).toHaveBeenCalledTimes(1);
  });
});
