import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PhotoSalesProvider, usePhotoSales } from '../PhotoSalesContext';
import { PhotoPurchaseBadge } from '../PhotoPurchaseBadge';
import { PhotoSalesCartButton } from '../PhotoSalesCartButton';
import { buildPhotoSalesConfig } from '../photoSales';

vi.mock('../../../config/api', () => ({ api: { post: vi.fn() } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (_key: string, fallback: string, values?: Record<string, unknown>) => fallback.replace(/{{(\w+)}}/g, (_, key) => String(values?.[key] ?? key)) }) }));
const { api } = await import('../../../config/api');
const photo = { id: 1, filename: 'Portrait.jpg', sale_token: 'proof', photo_price: 5 };
const config = (slug = 'one') => buildPhotoSalesConfig({ slug, event: { is_priced: true, photo_price: 5, free_photo_count: 1, promo_code: 'FOTO-ONCE' }, checkoutConfigured: true });
function ExtraPhoto() {
  const sales = usePhotoSales();
  return <button onClick={() => sales.addToCart({ ...photo, id: 2, filename: 'Landscape.jpg' })}>Add landscape</button>;
}
const Gallery = ({ slug = 'one' }: { slug?: string }) => <PhotoSalesProvider value={config(slug)}>
  <PhotoPurchaseBadge photo={photo} /><PhotoSalesCartButton /><ExtraPhoto />
</PhotoSalesProvider>;

describe('PicPeak photo cart', () => {
  beforeEach(() => { sessionStorage.clear(); vi.mocked(api.post).mockReset(); });
  it('shares tile, cart and lightbox selection, permits removal, and stores no sale credentials', async () => {
    render(<Gallery />);
    fireEvent.click(screen.getByRole('button', { name: 'Add photo to cart for €5.00' }));
    expect(screen.getByRole('button', { name: 'Cart, 1 photos' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add landscape' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cart, 2 photos' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('Portrait.jpg');
    expect(screen.getByRole('dialog')).toHaveTextContent('Landscape.jpg');
    fireEvent.click(screen.getByRole('button', { name: 'Remove Portrait.jpg from cart' }));
    expect(screen.queryByText('Portrait.jpg')).not.toBeInTheDocument();
    await waitFor(() => expect(sessionStorage.getItem('picpeak_photo_cart_one')).toContain('Landscape.jpg'));
    expect(sessionStorage.getItem('picpeak_photo_cart_one')).not.toMatch(/proof|sale_token|thumbnail|apiKey/);
    expect(document.querySelector('script[src*="snipcart"]')).toBeNull();
  });

  it('restores a cart after navigation and scopes it to its gallery', () => {
    sessionStorage.setItem('picpeak_photo_cart_one', JSON.stringify([{ id: 1, name: 'Portrait.jpg', price: 5 }]));
    const { rerender } = render(<Gallery />);
    expect(screen.getByRole('button', { name: 'Cart, 1 photos' })).toBeInTheDocument();
    rerender(<Gallery slug="two" />);
    expect(screen.getByRole('button', { name: 'Cart' })).toBeInTheDocument();
    rerender(<Gallery />);
    expect(screen.getByRole('button', { name: 'Cart, 1 photos' })).toBeInTheDocument();
  });

  it('preserves the checkout key after a network error and sends no browser-authored price', async () => {
    vi.mocked(api.post).mockRejectedValue(new Error('Network timeout'));
    render(<Gallery />);
    fireEvent.click(screen.getByRole('button', { name: 'Add photo to cart for €5.00' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cart, 1 photos' }));
    fireEvent.change(screen.getByLabelText('Promo code'), { target: { value: 'FOTO-ONCE' } });
    expect(screen.getByRole('dialog')).toHaveTextContent('€0.00');
    fireEvent.click(screen.getByRole('button', { name: 'Continue to payment' }));
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Continue to payment' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.post).mock.calls[0]).toEqual(vi.mocked(api.post).mock.calls[1]);
    expect(vi.mocked(api.post).mock.calls[0][1]).toEqual({ photoIds: [1], promoCode: 'FOTO-ONCE', checkoutKey: expect.any(String), browserKey: expect.stringMatching(/^[0-9a-f]{64}$/), language: 'en' });
  });

  it('purchase buttons do not open the photo tile behind them', () => {
    const openPhoto = vi.fn();
    render(<div onClick={openPhoto}><Gallery /></div>);
    fireEvent.click(screen.getByRole('button', { name: 'Add photo to cart for €5.00' }));
    expect(openPhoto).not.toHaveBeenCalled();
  });
});
