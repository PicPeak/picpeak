import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { validCheckoutDestination } from '../PhotoSalesCart';
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
    sessionStorage.setItem('picpeak_photo_promo_one', JSON.stringify({ grant: 'verified-promo-proof', expiresAt: Date.now() + 60000 }));
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
    expect(vi.mocked(api.post).mock.calls[0][1]).toEqual({ provider: 'stripe', photoIds: [1], promoCode: 'FOTO-ONCE', checkoutKey: expect.any(String), browserKey: expect.stringMatching(/^[0-9a-f]{64}$/), language: 'en', promoGrant: 'verified-promo-proof' });
  });

  it('purchase buttons do not open the photo tile behind them', () => {
    const openPhoto = vi.fn();
    render(<div onClick={openPhoto}><Gallery /></div>);
    fireEvent.click(screen.getByRole('button', { name: 'Add photo to cart for €5.00' }));
    expect(openPhoto).not.toHaveBeenCalled();
  });
  it('accepts only the exact Stripe origin or the local opaque confirmation route', () => {
    expect(validCheckoutDestination('https://checkout.stripe.com/c/pay/example')).toBe(true);
    expect(validCheckoutDestination(`/photo-checkout/${'a'.repeat(48)}`)).toBe(true);
    for (const url of ['https://checkout.stripe.com.attacker.test/', 'https://checkout.stripe.com@attacker.test/', '//checkout.stripe.com/c/pay/test', 'javascript:alert(1)', 'https://attacker.test/', '/photo-checkout/../../admin']) expect(validCheckoutDestination(url)).toBe(false);
  });
  it('shows one provider choice for both integrations with Stripe preselected, and sends the chosen provider', async () => {
    vi.mocked(api.post).mockRejectedValue(new Error('Keep page open'));
    const both = { ...config(), providers: ['stripe', 'snipcart'] as const };
    render(<PhotoSalesProvider value={{ ...both, providers: [...both.providers] }}><PhotoPurchaseBadge photo={photo} /><PhotoSalesCartButton /></PhotoSalesProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Add photo to cart for €5.00' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cart, 1 photos' }));
    expect(screen.getByRole('radio', { name: 'Stripe' })).toBeChecked();
    fireEvent.click(screen.getByRole('radio', { name: 'Snipcart' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('Close Snipcart to edit them in PicPeak');
    fireEvent.click(screen.getByRole('button', { name: 'Continue to payment' }));
    await screen.findByRole('alert');
    expect(api.post).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ provider: 'snipcart', photoIds: [1] }));
  });

  it('requires an email code only for a promo, retains the cart and sends only the verified grant to checkout', async () => {
    vi.mocked(api.post).mockResolvedValueOnce({ data: { challenge: 'a'.repeat(48), resendAfterSeconds: 60 } })
      .mockResolvedValueOnce({ data: { grant: 'verified-promo-proof', expiresInSeconds: 1800 } })
      .mockRejectedValueOnce(new Error('Keep page open'));
    render(<Gallery />);
    fireEvent.click(screen.getByRole('button', { name: 'Add photo to cart for €5.00' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cart, 1 photos' }));
    expect(screen.getByRole('button', { name: 'Continue to payment' })).toBeEnabled();
    fireEvent.change(screen.getByLabelText('Promo code'), { target: { value: 'FOTO-ONCE' } });
    expect(screen.getByRole('button', { name: 'Continue to payment' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Email for verification'), { target: { value: 'buyer@example.test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Email me a code' }));
    const code = await screen.findByLabelText('6-digit email code');
    expect(code).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Send another code in 60s' })).toBeDisabled();
    expect(JSON.stringify(sessionStorage)).not.toContain('buyer@example.test');
    fireEvent.change(code, { target: { value: '281604' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify email' }));
    await screen.findByText('Email verified for this promo.');
    fireEvent.click(screen.getByRole('button', { name: 'Continue to payment' }));
    await screen.findByRole('alert');
    expect(api.post).toHaveBeenNthCalledWith(1, '/gallery/one/checkout/promo-verification', expect.objectContaining({ email: 'buyer@example.test', promoCode: 'FOTO-ONCE', browserKey: expect.any(String) }));
    expect(api.post).toHaveBeenNthCalledWith(2, '/gallery/one/checkout/promo-verification/confirm', expect.objectContaining({ challenge: 'a'.repeat(48), code: '281604', browserKey: expect.any(String) }));
    expect(api.post).toHaveBeenNthCalledWith(3, '/gallery/one/checkout', expect.objectContaining({ promoGrant: 'verified-promo-proof', photoIds: [1] }));
    expect(vi.mocked(api.post).mock.calls[2][1]).not.toHaveProperty('email');
    expect(JSON.stringify(sessionStorage)).not.toMatch(/buyer@example.test|281604/);
    expect(screen.getByRole('dialog')).toHaveTextContent('Portrait.jpg');
  });

  it('allows code retries and does not discard photos when verification fails', async () => {
    vi.mocked(api.post).mockResolvedValueOnce({ data: { challenge: 'a'.repeat(48), resendAfterSeconds: 60 } })
      .mockRejectedValueOnce({ response: { data: { code: 'CHECKOUT_PROMO_CODE_INVALID' } } });
    render(<Gallery />);
    fireEvent.click(screen.getByRole('button', { name: 'Add photo to cart for €5.00' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cart, 1 photos' }));
    fireEvent.change(screen.getByLabelText('Promo code'), { target: { value: 'FOTO-ONCE' } });
    fireEvent.change(screen.getByLabelText('Email for verification'), { target: { value: 'buyer@example.test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Email me a code' }));
    fireEvent.change(await screen.findByLabelText('6-digit email code'), { target: { value: '281604' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify email' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('incorrect or has expired');
    expect(screen.getByRole('button', { name: 'Continue to payment' })).toBeDisabled();
    expect(screen.getByRole('dialog')).toHaveTextContent('Portrait.jpg');
    fireEvent.change(screen.getByLabelText('Promo code'), { target: { value: '' } });
    expect(screen.getByRole('button', { name: 'Continue to payment' })).toBeEnabled();
  });

  it('requires reverification after an expired server proof without losing the cart', async () => {
    sessionStorage.setItem('picpeak_photo_promo_one', JSON.stringify({ grant: 'expired-on-server', expiresAt: Date.now() + 60000 }));
    vi.mocked(api.post).mockRejectedValue({ response: { data: { code: 'CHECKOUT_PROMO_IDENTITY_REQUIRED' } } });
    render(<Gallery />);
    fireEvent.click(screen.getByRole('button', { name: 'Add photo to cart for €5.00' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cart, 1 photos' }));
    fireEvent.change(screen.getByLabelText('Promo code'), { target: { value: 'FOTO-ONCE' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue to payment' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('verify your email again');
    expect(screen.getByLabelText('Email for verification')).toBeInTheDocument();
    expect(sessionStorage.getItem('picpeak_photo_promo_one')).toBeNull();
    expect(screen.getByRole('dialog')).toHaveTextContent('Portrait.jpg');
  });

  it('restores the pending email-code challenge when the cart is closed and reopened, without storing the address', async () => {
    vi.mocked(api.post).mockResolvedValueOnce({ data: { challenge: 'a'.repeat(48), resendAfterSeconds: 60 } });
    render(<Gallery />);
    fireEvent.click(screen.getByRole('button', { name: 'Add photo to cart for €5.00' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cart, 1 photos' }));
    fireEvent.change(screen.getByLabelText('Promo code'), { target: { value: 'FOTO-ONCE' } });
    fireEvent.change(screen.getByLabelText('Email for verification'), { target: { value: 'buyer@example.test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Email me a code' }));
    await screen.findByLabelText('6-digit email code');
    fireEvent.click(screen.getByRole('button', { name: 'Keep browsing' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cart, 1 photos' }));
    expect(screen.getByLabelText('6-digit email code')).toBeInTheDocument();
    expect(screen.getByLabelText('Email for verification')).toHaveValue('');
    expect(JSON.stringify(sessionStorage)).not.toContain('buyer@example.test');
    expect(api.post).toHaveBeenCalledTimes(1);
  });

});
