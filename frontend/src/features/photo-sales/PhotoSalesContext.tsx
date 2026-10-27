import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { PhotoSalesPhoto } from './photoSales';

/**
 * Photo-sales context + Snipcart bootstrap.
 *
 * Mounted by GalleryView only for priced galleries. When the operator has
 * configured SNIPCART_API_KEY, the Snipcart v3 snippet is injected here —
 * nowhere else, so non-priced galleries never load it.
 *
 * The context also mirrors Snipcart's cart (item count and item ids) from its
 * store, so the header button shows a count only when there is one and a
 * photo already in the cart reads "In cart" instead of offering itself again.
 */

export interface PhotoSalesContextValue {
  enabled: boolean;
  apiKey: string | null;
  slug: string;
  price: number;
  currency: string;
  priceCheckUrl: string;
  /** Cart line description (PhotoSalesConfig.itemDescription). */
  itemDescription: string;
  freeCount: number;
  photos: PhotoSalesPhoto[];
  /** True when the checkout UI can actually be shown (priced + key set). */
  checkoutReady: boolean;
}

interface PhotoSalesCart {
  /** Lines in the Snipcart cart; 0 until Snipcart is ready. */
  cartCount: number;
  /** data-item-id of every line in the cart. */
  cartItemIds: ReadonlySet<string>;
}

const EMPTY_CART: PhotoSalesCart = { cartCount: 0, cartItemIds: new Set() };

const PhotoSalesContext = createContext<PhotoSalesContextValue & PhotoSalesCart>({
  enabled: false,
  apiKey: null,
  slug: '',
  price: 0,
  currency: 'EUR',
  priceCheckUrl: '',
  itemDescription: '',
  freeCount: 0,
  photos: [],
  checkoutReady: false,
  ...EMPTY_CART,
});

export const usePhotoSales = () => useContext(PhotoSalesContext);

interface PhotoSalesProviderProps {
  value: PhotoSalesContextValue;
  children: React.ReactNode;
}

const SNIPCART_SCRIPT_ID = 'picpeak-snipcart-script';
// Pinned with Subresource Integrity: the cart runs with full DOM access on a
// gallery page (session tokens included), so a changed file must not load.
// Bump the version and both hashes together.
const SNIPCART_BASE = 'https://cdn.snipcart.com/themes/v3.4.0/default';
const SNIPCART_JS_SRI = 'sha384-Ng5jyc+Z1tBbrYjy5X1LU8rD7tAA1u3XIH8a3JeP1v34DBBget/DUfzFMwxaIGjI';
const SNIPCART_CSS_SRI = 'sha384-GcTP/2FrySWN/RIPE7xKE8PEK5oO8niC1UyC9x6MXj2UiaxSdUO+cLFm9qAOHjl/';

// The slice of Snipcart v3's global this feature reads.
interface SnipcartStoreState {
  cart?: { items?: { count?: number; items?: Array<{ id?: string }> } };
}
interface SnipcartGlobal {
  store?: {
    getState: () => SnipcartStoreState;
    subscribe: (listener: () => void) => () => void;
  };
}

function readCart(state: SnipcartStoreState | undefined): PhotoSalesCart {
  const items = state?.cart?.items?.items ?? [];
  return {
    cartCount: Number(state?.cart?.items?.count ?? items.length) || 0,
    cartItemIds: new Set(items.map((item) => String(item?.id ?? ''))),
  };
}

/** Snipcart's cart, live; empty until (and unless) Snipcart is ready. */
function useSnipcartCart(active: boolean): PhotoSalesCart {
  const [cart, setCart] = useState<PhotoSalesCart>(EMPTY_CART);

  useEffect(() => {
    if (!active) return undefined;
    let unsubscribe: (() => void) | undefined;
    const attach = () => {
      const store = (window as unknown as { Snipcart?: SnipcartGlobal }).Snipcart?.store;
      if (!store || unsubscribe) return;
      const update = () => setCart(readCart(store.getState()));
      update();
      unsubscribe = store.subscribe(update);
    };
    attach();
    document.addEventListener('snipcart.ready', attach);
    return () => {
      document.removeEventListener('snipcart.ready', attach);
      unsubscribe?.();
    };
  }, [active]);

  return cart;
}

export const PhotoSalesProvider: React.FC<PhotoSalesProviderProps> = ({ value, children }) => {
  const { checkoutReady, apiKey } = value;
  const cart = useSnipcartCart(checkoutReady && !!apiKey);

  useEffect(() => {
    if (!checkoutReady || !apiKey) return undefined;
    if (document.getElementById(SNIPCART_SCRIPT_ID)) return undefined;

    const script = document.createElement('script');
    script.id = SNIPCART_SCRIPT_ID;
    script.src = `${SNIPCART_BASE}/snipcart.js`;
    script.integrity = SNIPCART_JS_SRI;
    script.crossOrigin = 'anonymous';
    script.async = true;
    document.head.appendChild(script);

    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = `${SNIPCART_BASE}/snipcart.css`;
    link.integrity = SNIPCART_CSS_SRI;
    link.crossOrigin = 'anonymous';
    document.head.appendChild(link);

    return () => {
      // Left in place for the life of the gallery visit: Snipcart keeps a
      // global singleton and removing it mid-checkout would break the cart.
    };
  }, [checkoutReady, apiKey]);

  // Photo sales: NO client-side cart re-pricing. Every line keeps
  // its base price; the free quota is a ONE-TIME promo code (Snipcart
  // discount) the buyer enters at checkout — created and verified
  // server-side (modules/photoSales/promoDiscount.js + webhook audit).
  const contextValue = useMemo(() => ({ ...value, ...cart }), [value, cart]);

  return (
    <PhotoSalesContext.Provider value={contextValue}>
      {checkoutReady && apiKey && typeof document !== 'undefined' && createPortal(
        // Snipcart mounts its cart UI into this hidden element. Portaled to
        // <body> so no ancestor transform/stacking context can trap the
        // fixed-position modal behind the gallery chrome (unclosable cart).
        // add-product-behavior "none" keeps the cart closed when a photo is
        // added — the header cart button (badge count) opens it instead.
        <div
          hidden
          id="snipcart"
          data-api-key={apiKey}
          data-config-modal-style="side"
          data-config-add-product-behavior="none"
          data-currency="eur"
        />,
        document.body
      )}
      {children}
    </PhotoSalesContext.Provider>
  );
};
