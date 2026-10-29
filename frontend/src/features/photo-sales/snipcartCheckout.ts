import './snipcartCheckout.css';

/** Snipcart is loaded only after the buyer selects it and continues. */
export interface SnipcartHandoff {
  checkout_token: string;
  promo_code: string;
  expires_at: string;
  items: Array<{ id: string; name: string; price: number; quantity: number; minQuantity: number; maxQuantity: number; shippable: boolean; url: string; customFields: Array<{ name: string; value: string; type: string }> }>;
}
interface SnipcartSdk {
  store: { getState: () => { cart: { items: { items: Array<{ uniqueId: string }> }; discounts: { items: Array<{ code: string }> } } } };
  api: {
    cart: { items: { remove: (id: string) => Promise<unknown>; add: (...items: SnipcartHandoff['items']) => Promise<unknown> }; applyDiscount: (code: string) => Promise<unknown>; removeDiscount: (code: string) => Promise<unknown> };
    theme: { cart: { open: () => void } };
  };
  events: { on: (event: string, callback: () => void) => () => void };
}
const sdk = () => (window as unknown as { Snipcart?: SnipcartSdk }).Snipcart;
let loading: Promise<SnipcartSdk> | undefined;
let configuredKey: string | undefined;
let unsubscribe: (() => void) | undefined;
function load(publicKey: string): Promise<SnipcartSdk> {
  if (configuredKey && configuredKey !== publicKey) return Promise.reject(new Error('Reload after a store configuration change'));
  let root = document.getElementById('snipcart');
  if (!root) {
    root = document.createElement('div');
    root.id = 'snipcart'; root.hidden = true;
    root.dataset.apiKey = publicKey; root.dataset.currency = 'eur';
    root.dataset.configModalStyle = 'side'; root.dataset.configAddProductBehavior = 'none';
    document.body.appendChild(root);
  }
  // Apply before SDK startup/open, including a cart restored by Snipcart.
  root.classList.add('picpeak-photo-checkout');
  if (sdk()?.api) return Promise.resolve(sdk()!);
  if (loading) return loading;
  configuredKey = publicKey;
  loading = new Promise((resolve, reject) => {
    let script: HTMLScriptElement;
    const cleanup = () => { clearTimeout(timeout); document.removeEventListener('snipcart.ready', ready); };
    const ready = () => { if (sdk()?.api) { cleanup(); resolve(sdk()!); } };
    const fail = () => { cleanup(); loading = undefined; script?.remove(); reject(new Error('Payment provider could not load')); };
    const timeout = window.setTimeout(fail, 30000);
    document.addEventListener('snipcart.ready', ready);
    if (!document.getElementById('picpeak-snipcart-css')) {
      const css = document.createElement('link');
      css.id = 'picpeak-snipcart-css'; css.rel = 'stylesheet';
      css.href = 'https://cdn.snipcart.com/themes/v3.4.0/default/snipcart.css';
      css.integrity = 'sha384-GcTP/2FrySWN/RIPE7xKE8PEK5oO8niC1UyC9x6MXj2UiaxSdUO+cLFm9qAOHjl/';
      css.crossOrigin = 'anonymous'; document.head.appendChild(css);
    }
    script = document.createElement('script'); script.async = true;
    script.src = 'https://cdn.snipcart.com/themes/v3.4.0/default/snipcart.js';
    script.integrity = 'sha384-Ng5jyc+Z1tBbrYjy5X1LU8rD7tAA1u3XIH8a3JeP1v34DBBget/DUfzFMwxaIGjI';
    script.crossOrigin = 'anonymous'; script.onerror = fail;
    document.head.appendChild(script);
  });
  return loading;
}
export async function openSnipcartCheckout(publicKey: string, handoff: SnipcartHandoff): Promise<void> {
  if (!publicKey || !/^[0-9a-f]{48}$/.test(handoff.checkout_token) || Date.parse(handoff.expires_at) <= Date.now()) throw new Error('Invalid checkout');
  const provider = await load(publicKey);
  // Replace the provider cart from the server quote, including a cart left by
  // a different gallery. PicPeak remains the one place buyers select photos.
  for (const item of [...provider.store.getState().cart.items.items]) await provider.api.cart.items.remove(item.uniqueId);
  for (const discount of [...provider.store.getState().cart.discounts.items]) await provider.api.cart.removeDiscount(discount.code);
  await provider.api.cart.items.add(...handoff.items);
  if (handoff.promo_code) await provider.api.cart.applyDiscount(handoff.promo_code);
  unsubscribe?.();
  unsubscribe = provider.events.on('cart.confirmed', () => {
    unsubscribe?.(); unsubscribe = undefined;
    window.location.assign(`/photo-checkout/${handoff.checkout_token}`);
  });
  provider.api.theme.cart.open();
}
