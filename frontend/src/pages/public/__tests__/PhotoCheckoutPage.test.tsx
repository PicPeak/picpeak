import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { PhotoCheckoutPage } from '../PhotoCheckoutPage';

vi.mock('../../../config/api', () => ({ api: { get: vi.fn(), post: vi.fn() } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (_key: string, fallback: string) => fallback }) }));
const { api } = await import('../../../config/api');
const status = (state = 'pending') => ({ status: state, gallery_url: '/gallery/example', gallery_slug: 'example',
  purchased_photo_ids: state === 'completed' ? [1] : [], download_url: state === 'completed' ? '/purchased-downloads/purchase-proof' : null });
const show = (suffix = '') => render(<MemoryRouter initialEntries={['/photo-checkout/return-id' + suffix]}>
  <Routes><Route path="/photo-checkout/:token" element={<PhotoCheckoutPage />} /></Routes>
</MemoryRouter>);

describe('photo checkout confirmation', () => {
  beforeEach(() => {
    sessionStorage.clear();
    sessionStorage.setItem('picpeak_photo_checkout_browser', 'a'.repeat(64));
    vi.mocked(api.get).mockReset(); vi.mocked(api.post).mockReset();
  });
  it('waits for confirmation, then exposes downloads and removes only purchased cart items', async () => {
    sessionStorage.setItem('picpeak_photo_cart_example', JSON.stringify([{ id: 1 }, { id: 2 }]));
    vi.mocked(api.get).mockResolvedValueOnce({ data: status() }).mockResolvedValue({ data: status('completed') });
    show();
    await screen.findByRole('link', { name: 'Return to gallery' });
    expect(screen.queryByRole('link', { name: 'Open downloads' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    expect(await screen.findByRole('link', { name: 'Open downloads' })).toHaveAttribute('href', '/purchased-downloads/purchase-proof');
    expect(sessionStorage.getItem('picpeak_photo_cart_example')).toBe(JSON.stringify([{ id: 2 }]));
    expect(api.get).toHaveBeenCalledWith('/photo-checkout/return-id', { headers: { 'X-Photo-Checkout-Key': 'a'.repeat(64) } });
  });
  it('confirms cancellation server-side before showing the ended state', async () => {
    vi.mocked(api.post).mockResolvedValue({ data: { ok: true } });
    vi.mocked(api.get).mockResolvedValue({ data: status('expired') });
    show('?cancelled=1');
    await screen.findByRole('heading', { name: 'Checkout has ended' });
    expect(api.post).toHaveBeenCalledWith('/photo-checkout/return-id/cancel', {}, { headers: { 'X-Photo-Checkout-Key': 'a'.repeat(64) } });
    expect(screen.queryByRole('link', { name: 'Open downloads' })).not.toBeInTheDocument();
  });
  it('shows a recoverable error and never treats a failed cancellation as confirmed', async () => {
    vi.mocked(api.post).mockRejectedValue(new Error('Provider unreachable'));
    show('?cancelled=1');
    await screen.findByRole('heading', { name: 'We could not confirm your checkout' });
    expect(screen.getByText(/download link emailed/)).toBeInTheDocument();
    expect(api.get).not.toHaveBeenCalled();
    expect(screen.queryByRole('heading', { name: 'Checkout has ended' })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Check again' })).toBeEnabled());
  });
});
