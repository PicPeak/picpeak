import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const handoff = () => ({ checkout_token: crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '').slice(0, 16),
  expires_at: new Date(Date.now() + 1800000).toISOString(), promo_code: 'FOTO-ONCE',
  items: [{ id: 'gallery-photo-1', name: 'Portrait', price: 5, quantity: 1, minQuantity: 1, maxQuantity: 1, shippable: false,
    url: 'https://photos.example.test/api/gallery/one/price-check', customFields: [{ name: 'photoId', value: '1', type: 'hidden' }] }] });
function fixture() {
  const provider = {
    ready: Promise.resolve(),
    store: { getState: () => ({ cart: { items: { items: [{ uniqueId: 'old-gallery-photo' }] }, discounts: { items: [{ code: 'OLD-CODE' }] } } }) },
    api: { cart: { items: { remove: vi.fn(async () => {}), add: vi.fn(async () => {}) }, removeDiscount: vi.fn(async () => {}), applyDiscount: vi.fn(async () => {}) }, theme: { cart: { open: vi.fn() } } },
    events: { on: vi.fn(() => vi.fn()) },
  };
  Object.assign(window, { Snipcart: provider }); return provider;
}
describe('Snipcart handoff', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => {
    vi.useRealTimers();
    Reflect.deleteProperty(window, 'Snipcart');
    document.getElementById('snipcart')?.remove();
    document.body.classList.remove('picpeak-photo-checkout');
  });
  it('replaces provider items and discounts with the server quote before opening payment', async () => {
    const provider = fixture(); const quote = handoff();
    const { openSnipcartCheckout } = await import('../snipcartCheckout');
    await openSnipcartCheckout(crypto.randomUUID(), quote);
    expect(provider.api.cart.items.remove).toHaveBeenCalledWith('old-gallery-photo');
    expect(provider.api.cart.removeDiscount).toHaveBeenCalledWith('OLD-CODE');
    expect(provider.api.cart.items.add).toHaveBeenCalledWith(...quote.items);
    expect(provider.api.cart.applyDiscount).toHaveBeenCalledWith('FOTO-ONCE');
    expect(provider.api.theme.cart.open).toHaveBeenCalledOnce();
    expect(document.body).toHaveClass('picpeak-photo-checkout');
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
  it('waits for the persisted cart to load before replacing its items and discounts', async () => {
    const provider = fixture();
    let ready!: () => void;
    provider.ready = new Promise<void>((resolve) => { ready = resolve; });
    const { openSnipcartCheckout } = await import('../snipcartCheckout');
    const opening = openSnipcartCheckout(crypto.randomUUID(), handoff());
    await Promise.resolve();
    expect(provider.api.cart.items.remove).not.toHaveBeenCalled();
    expect(provider.api.cart.items.add).not.toHaveBeenCalled();
    ready();
    await opening;
    expect(provider.api.cart.items.remove).toHaveBeenCalledWith('old-gallery-photo');
    expect(provider.api.cart.removeDiscount).toHaveBeenCalledWith('OLD-CODE');
    expect(provider.api.theme.cart.open).toHaveBeenCalledOnce();
  });
  it('keeps the fixed-cart CSS scope when the SDK replaces its root', async () => {
    fixture();
    const { openSnipcartCheckout } = await import('../snipcartCheckout');
    await openSnipcartCheckout(crypto.randomUUID(), handoff());
    const replacement = document.createElement('div');
    replacement.id = 'snipcart'; replacement.className = 'snipcart';
    document.getElementById('snipcart')!.replaceWith(replacement);
    expect(replacement.matches('body.picpeak-photo-checkout #snipcart')).toBe(true);
  });
  it('unlocks the caller after a hung mutation and prevents late opening or an unsafe retry', async () => {
    vi.useFakeTimers();
    const provider = fixture();
    let added!: () => void;
    provider.api.cart.items.add.mockImplementationOnce(() => new Promise<void>((resolve) => { added = resolve; }));
    const { openSnipcartCheckout } = await import('../snipcartCheckout');
    const quote = handoff();
    const opening = openSnipcartCheckout(crypto.randomUUID(), quote);
    const failure = expect(opening).rejects.toMatchObject({ code: 'SNIPCART_RELOAD_REQUIRED' });
    await vi.advanceTimersByTimeAsync(30000);
    await failure;
    added();
    await vi.advanceTimersByTimeAsync(0);
    expect(provider.api.cart.applyDiscount).not.toHaveBeenCalled();
    expect(provider.api.theme.cart.open).not.toHaveBeenCalled();
    await expect(openSnipcartCheckout(crypto.randomUUID(), quote)).rejects.toMatchObject({ code: 'SNIPCART_RELOAD_REQUIRED' });
    expect(provider.api.cart.items.add).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not touch the cart if session readiness arrives after the deadline', async () => {
    vi.useFakeTimers();
    const provider = fixture();
    let ready!: () => void;
    provider.ready = new Promise<void>((resolve) => { ready = resolve; });
    const { openSnipcartCheckout } = await import('../snipcartCheckout');
    const opening = openSnipcartCheckout(crypto.randomUUID(), handoff());
    const failure = expect(opening).rejects.toMatchObject({ code: 'SNIPCART_RELOAD_REQUIRED' });
    await vi.advanceTimersByTimeAsync(30000);
    await failure;
    ready();
    await vi.advanceTimersByTimeAsync(0);
    expect(provider.api.cart.items.remove).not.toHaveBeenCalled();
    expect(provider.api.cart.items.add).not.toHaveBeenCalled();
    expect(provider.api.theme.cart.open).not.toHaveBeenCalled();
  });
});
