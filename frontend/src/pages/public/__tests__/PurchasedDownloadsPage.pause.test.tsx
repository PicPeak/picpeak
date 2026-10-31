import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../../../config/api', () => ({ api: { get } }));
vi.mock('../../../hooks/useLocalizedDate', () => ({ useLocalizedDate: () => ({ formatDateTime: (value: string) => value }) }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback?: string, values?: { date?: string }) => (fallback || _key).replace('{{date}}', values?.date || '') }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

import { PurchasedDownloadsPage } from '../PurchasedDownloadsPage';

const access = {
  order_id: 'paid-order', gallery_slug: 'wedding', gallery_name: 'Wedding', buyer_email: 'buyer@example.test',
  expires_at: '2026-12-01T12:00:00Z', photos: [{ id: 7, filename: 'photo.jpg', photo_url: '/api/gallery/purchased-downloads/proof/photos/7' }],
};
const paused = { ...access, temporarily_disabled: true, support_email: 'help@example.test', photo_count: 1, photos: [], gallery_expires_at: '2027-01-01T12:00:00Z' };
const mount = () => render(<MemoryRouter initialEntries={['/purchased-downloads/proof']}>
  <Routes><Route path="/purchased-downloads/:accessToken" element={<PurchasedDownloadsPage />} /></Routes>
</MemoryRouter>);

describe('purchased downloads during a gallery pause', () => {
  beforeEach(() => { get.mockReset(); });

  it('confirms the purchase, pause compensation, gallery cutoff and contact address, with no download links', async () => {
    get.mockResolvedValue({ data: paused });
    mount();
    expect(await screen.findByRole('heading', { name: 'Your purchase was successful' })).toBeInTheDocument();
    expect(screen.getByText(/Time lost during the pause will be added/)).toBeInTheDocument();
    expect(screen.getByText(/Gallery expiry: 2027-01-01T12:00:00Z/)).toBeInTheDocument();
    expect(screen.queryByText(/2026-12-01T12:00:00Z/)).toBeNull();
    expect(screen.getByRole('link', { name: 'help@example.test' })).toHaveAttribute('href', 'mailto:help@example.test');
    expect(screen.queryByRole('link', { name: /Download/ })).toBeNull();
    expect(screen.queryByText('Access expired')).toBeNull();
  });

  it('restores downloads through the same purchase link when the visitor retries after re-enabling', async () => {
    get.mockResolvedValueOnce({ data: paused }).mockResolvedValueOnce({ data: access });
    mount();
    await screen.findByRole('heading', { name: 'Your purchase was successful' });
    fireEvent.click(screen.getByRole('button', { name: 'gallery.tryAgain' }));
    expect(await screen.findByRole('link', { name: 'Download photo.jpg' })).toHaveAttribute('href', access.photos[0].photo_url);
    expect(get.mock.calls.map((call) => call[0])).toEqual(['/gallery/purchased-downloads/proof', '/gallery/purchased-downloads/proof']);
  });

  it('checks again before a download and explains a pause that started after the page loaded', async () => {
    get.mockResolvedValueOnce({ data: access }).mockResolvedValueOnce({ data: paused });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    try {
      mount();
      fireEvent.click(await screen.findByRole('link', { name: 'Download photo.jpg' }));
      expect(await screen.findByRole('heading', { name: 'Your purchase was successful' })).toBeInTheDocument();
      expect(click).not.toHaveBeenCalled();
      expect(screen.queryByRole('link', { name: /Download/ })).toBeNull();
    } finally { click.mockRestore(); }
  });

  it('never confirms an expired or revoked purchase as successful', async () => {
    get.mockRejectedValue(Object.assign(new Error('Access expired'), { response: { status: 403 } }));
    mount();
    expect(await screen.findByRole('heading', { name: 'Access expired' })).toBeInTheDocument();
    expect(screen.queryByText('Your purchase was successful')).toBeNull();
  });

  it('does not invent an email address when the installation has none configured', async () => {
    get.mockResolvedValue({ data: { ...paused, support_email: '' } });
    mount();
    await screen.findByRole('heading', { name: 'Your purchase was successful' });
    expect(screen.getByText('Please contact your photographer for more information.')).toBeInTheDocument();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('hands a still-authorised original to the native browser downloader', async () => {
    get.mockResolvedValue({ data: access });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    try {
      mount();
      fireEvent.click(await screen.findByRole('link', { name: 'Download photo.jpg' }));
      await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
      expect((click.mock.instances[0] as HTMLAnchorElement).getAttribute('href')).toBe(access.photos[0].photo_url);
    } finally { click.mockRestore(); }
  });
});
