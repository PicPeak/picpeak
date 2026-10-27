import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const handoff = () => ({ checkout_token: crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '').slice(0, 16),
  expires_at: new Date(Date.now() + 1800000).toISOString(), promo_code: 'FOTO-ONCE',
  items: [{ id: 'gallery-photo-1', name: 'Portrait', price: 5, quantity: 1, maxQuantity: 1, shippable: false,
    url: 'https://photos.example.test/api/gallery/one/price-check', customFields: [{ name: 'photoId', value: '1', type: 'hidden' }] }] });
function fixture() {
  const provider = {
    store: { getState: () => ({ cart: { items: { items: [{ uniqueId: 'old-gallery-photo' }] }, discounts: { items: [{ code: 'OLD-CODE' }] } } }) },
    api: { cart: { items: { remove: vi.fn(async () => {}), add: vi.fn(async () => {}) }, removeDiscount: vi.fn(async () => {}), applyDiscount: vi.fn(async () => {}) }, theme: { cart: { open: vi.fn() } } },
    events: { on: vi.fn(() => vi.fn()) },
  };
  Object.assign(window, { Snipcart: provider }); return provider;
}
describe('Snipcart handoff', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => { Reflect.deleteProperty(window, 'Snipcart'); });
  it('replaces provider items and discounts with the server quote before opening payment', async () => {
    const provider = fixture(); const quote = handoff();
    const { openSnipcartCheckout } = await import('../snipcartCheckout');
    await openSnipcartCheckout(crypto.randomUUID(), quote);
    expect(provider.api.cart.items.remove).toHaveBeenCalledWith('old-gallery-photo');
    expect(provider.api.cart.removeDiscount).toHaveBeenCalledWith('OLD-CODE');
    expect(provider.api.cart.items.add).toHaveBeenCalledWith(...quote.items);
    expect(provider.api.cart.applyDiscount).toHaveBeenCalledWith('FOTO-ONCE');
    expect(provider.api.theme.cart.open).toHaveBeenCalledOnce();
    expect(provider.events.on).toHaveBeenCalledWith('cart.confirmed', expect.any(Function));
    expect(document.querySelector('script[src*="snipcart"]')).toBeNull();
  });
  it('does not open a partially updated cart when the provider rejects an item', async () => {
    const provider = fixture(); provider.api.cart.items.add.mockRejectedValueOnce(new Error('Provider unavailable'));
    const { openSnipcartCheckout } = await import('../snipcartCheckout');
    await expect(openSnipcartCheckout(crypto.randomUUID(), handoff())).rejects.toThrow();
    expect(provider.api.theme.cart.open).not.toHaveBeenCalled();
    expect(provider.api.cart.applyDiscount).not.toHaveBeenCalled();
  });
  it('rejects an expired handoff before touching the provider cart', async () => {
    const provider = fixture(); const quote = { ...handoff(), expires_at: new Date(Date.now() - 1).toISOString() };
    const { openSnipcartCheckout } = await import('../snipcartCheckout');
    await expect(openSnipcartCheckout(crypto.randomUUID(), quote)).rejects.toThrow();
    expect(provider.api.cart.items.remove).not.toHaveBeenCalled();
  });
});
