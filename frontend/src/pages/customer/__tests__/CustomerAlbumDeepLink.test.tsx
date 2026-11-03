import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { CustomerEventPage } from '../CustomerEventPage';
import { customerService } from '../../../services/customer.service';

vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (_key: string, fallback: string) => fallback }),
}));
vi.mock('../../../hooks/useLocalizedDate', () => ({ useLocalizedDate: () => ({ format: (v: string) => v, formatExpiry: (v: string) => v }) }));
vi.mock('../../../services/customer.service', () => ({ customerService: { getEventOverview: vi.fn(), getEventAccessToken: vi.fn() } }));
vi.mock('../../../utils/galleryAuthStorage', () => ({ storeGalleryToken: vi.fn(), setActiveGallerySlug: vi.fn() }));
vi.mock('../CustomerDocumentsPage', () => ({ CustomerDocumentList: () => null }));

const overview = (productOffers: object[], availability = 'active') => ({
  event: { id: 1, slug: 'wedding', eventName: 'Wedding', eventDate: null, expiresAt: null, availability },
  sections: { quotes: false, contracts: false, invoices: false, documents: false },
  quotes: [], contracts: [], invoices: [], documents: [], productOffers,
});
const Where = () => { const l = useLocation(); return <p>{`at ${l.pathname}${l.search}`}</p>; };
const mount = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter initialEntries={['/customer/events/wedding']}>
      <Routes>
        <Route path="/customer/events/:slug" element={<CustomerEventPage />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>
  </QueryClientProvider>,
);
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('customer portal album link', () => {
  const released = { id: 'offer-a', name: 'Fine art album', status: 'draft', confirmed: false, guided: true };
  it('links a released album straight into the gallery flow', async () => {
    vi.mocked(customerService.getEventOverview).mockResolvedValue(overview([released]) as never);
    vi.mocked(customerService.getEventAccessToken).mockResolvedValue({ token: 'gallery' } as never);
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Configure your album' }));
    expect(await screen.findByText('at /gallery/wedding?album=offer-a')).toBeInTheDocument();
    await waitFor(() => expect(customerService.getEventAccessToken).toHaveBeenCalledWith('wedding'));
  });
  it('sends a client with several albums to the album choice, in one entry', async () => {
    vi.mocked(customerService.getEventOverview).mockResolvedValue(overview([released, { ...released, id: 'offer-b', name: 'Panorama' }]) as never);
    vi.mocked(customerService.getEventAccessToken).mockResolvedValue({ token: 'gallery' } as never);
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Configure your album' }));
    expect(await screen.findByText('at /gallery/wedding?album=choose')).toBeInTheDocument();
  });
  it('says so once the selection is confirmed', async () => {
    vi.mocked(customerService.getEventOverview).mockResolvedValue(overview([{ ...released, status: 'submitted', confirmed: true }]) as never);
    mount();
    expect(await screen.findByRole('button', { name: 'View your selection' })).toBeInTheDocument();
    expect(screen.getByText('Fine art album: Your selection is confirmed.')).toBeInTheDocument();
  });
  it('shows nothing with no release, for a classic product, or while the gallery cannot open', async () => {
    vi.mocked(customerService.getEventOverview).mockResolvedValue(overview([]) as never);
    mount();
    await screen.findByText('Wedding');
    expect(screen.queryByText('Your album')).not.toBeInTheDocument();
    cleanup();
    vi.mocked(customerService.getEventOverview).mockResolvedValue(overview([{ ...released, guided: false }]) as never);
    mount();
    await screen.findByText('Wedding');
    expect(screen.queryByText('Your album')).not.toBeInTheDocument();
    cleanup();
    vi.mocked(customerService.getEventOverview).mockResolvedValue(overview([released], 'expired') as never);
    mount();
    await screen.findByText('Wedding');
    expect(screen.queryByText('Your album')).not.toBeInTheDocument();
  });
});
