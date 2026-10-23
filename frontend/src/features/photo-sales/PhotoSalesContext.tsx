import React, { createContext, useContext, useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { PhotoSalesPhoto } from './photoSales';

/**
 * Photo-sales context + Snipcart bootstrap.
 *
 * Mounted by GalleryView only for priced galleries. When the operator has
 * configured SNIPCART_API_KEY, the Snipcart v3 snippet is injected here —
 * nowhere else, so non-priced galleries never load it.
 */

export interface PhotoSalesContextValue {
  enabled: boolean;
  apiKey: string | null;
  slug: string;
  price: number;
  currency: string;
  priceCheckUrl: string;
  freeCount: number;
  photos: PhotoSalesPhoto[];
  /** True when the checkout UI can actually be shown (priced + key set). */
  checkoutReady: boolean;
}

const PhotoSalesContext = createContext<PhotoSalesContextValue>({
  enabled: false,
  apiKey: null,
  slug: '',
  price: 0,
  currency: 'EUR',
  priceCheckUrl: '',
  freeCount: 0,
  photos: [],
  checkoutReady: false,
});

export const usePhotoSales = () => useContext(PhotoSalesContext);

interface PhotoSalesProviderProps {
  value: PhotoSalesContextValue;
  children: React.ReactNode;
}

const SNIPCART_SCRIPT_ID = 'picpeak-snipcart-script';

export const PhotoSalesProvider: React.FC<PhotoSalesProviderProps> = ({ value, children }) => {
  const { checkoutReady, apiKey } = value;

  useEffect(() => {
    if (!checkoutReady || !apiKey) return undefined;
    if (document.getElementById(SNIPCART_SCRIPT_ID)) return undefined;

    const script = document.createElement('script');
    script.id = SNIPCART_SCRIPT_ID;
    script.src = 'https://cdn.snipcart.com/themes/v3.4.0/default/snipcart.js';
    script.async = true;
    document.head.appendChild(script);

    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://cdn.snipcart.com/themes/v3.4.0/default/snipcart.css';
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

  return (
    <PhotoSalesContext.Provider value={value}>
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
