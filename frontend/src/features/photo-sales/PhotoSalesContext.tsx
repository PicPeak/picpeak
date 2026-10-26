import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { PhotoSalesConfig } from './photoSales';
import { effectivePhotoPrice } from './photoSales';
import { PhotoSalesCart } from './PhotoSalesCart';

export interface PurchasePhoto {
  id: number;
  filename?: string;
  original_filename?: string | null;
  thumbnail_url?: string | null;
  photo_price?: number | null;
  sale_token?: string | null;
}

export interface CartPhoto { id: number; name: string; price: number; thumbnail?: string | null }

interface PhotoSalesCartValue {
  cartCount: number;
  cartItemIds: ReadonlySet<number>;
  addToCart: (photo: PurchasePhoto) => void;
  openCart: () => void;
}

const PhotoSalesContext = createContext<PhotoSalesConfig & PhotoSalesCartValue>({
  enabled: false, checkoutReady: false, slug: '', price: 0, currency: 'EUR',
  itemDescription: '', freeCount: 0, accessDays: 30, promoCode: null,
  cartCount: 0, cartItemIds: new Set(), addToCart: () => {}, openCart: () => {},
});

export const usePhotoSales = () => useContext(PhotoSalesContext);

const storageKey = (slug: string) => `picpeak_photo_cart_${slug}`;

function readCart(slug: string): CartPhoto[] {
  try {
    const saved: unknown = JSON.parse(sessionStorage.getItem(storageKey(slug)) || '[]');
    if (!Array.isArray(saved)) return [];
    const ids = new Set<number>();
    return saved.filter((item): item is CartPhoto => {
      if (!item || !Number.isSafeInteger(item.id) || item.id <= 0 || ids.has(item.id)
          || typeof item.name !== 'string' || typeof item.price !== 'number' || !Number.isFinite(item.price) || item.price < 0) return false;
      ids.add(item.id);
      return true;
    }).slice(0, 100).map(({ id, name, price }) => ({ id, name, price }));
  } catch { return []; }
}

export const PhotoSalesProvider: React.FC<{ value: PhotoSalesConfig; photos?: PurchasePhoto[]; children: React.ReactNode }> = ({ value, photos = [], children }) => {
  const [scope, setScope] = useState(value.slug);
  const [items, setItems] = useState<CartPhoto[]>(() => readCart(value.slug));
  const [open, setOpen] = useState(false);
  if (scope !== value.slug) {
    // Converges after one render, so a new gallery never inherits a cart
    // or an open checkout dialog from the previous gallery.
    setScope(value.slug);
    setItems(readCart(value.slug));
    setOpen(false);
  }
  useEffect(() => {
    try {
      // No gallery JWTs, sale tokens, private image URLs or payment secrets
      // in browser persistence. Displayed prices are rechecked server-side.
      sessionStorage.setItem(storageKey(scope), JSON.stringify(items.map(({ id, name, price }) => ({ id, name, price }))));
    } catch { /* The cart still works when browser storage is unavailable. */ }
  }, [scope, items]);
  const cartItemIds = useMemo(() => new Set(items.map((item) => item.id)), [items]);
  const currentPhotos = useMemo(() => new Map(photos.map((photo) => [photo.id, photo])), [photos]);
  // Restore private thumbnails from the authenticated response, never from
  // browser persistence. Filters may hide a cart item without removing it.
  const displayedItems = items.map((item) => {
    const photo = currentPhotos.get(item.id);
    return photo ? { ...item, thumbnail: photo.thumbnail_url, price: effectivePhotoPrice(value.price, photo.photo_price) } : item;
  });
  const addToCart = (photo: PurchasePhoto) => {
    if (!value.checkoutReady || !photo.sale_token) return;
    if (items.length >= 100) { setOpen(true); return; }
    setItems((current) => current.some((item) => item.id === photo.id) || current.length >= 100 ? current : [...current, {
      id: photo.id, name: photo.original_filename || photo.filename || `Photo ${photo.id}`,
      price: effectivePhotoPrice(value.price, photo.photo_price), thumbnail: photo.thumbnail_url,
    }]);
  };
  return (
    <PhotoSalesContext.Provider value={{ ...value, cartCount: items.length, cartItemIds, addToCart, openCart: () => setOpen(true) }}>
      {children}
      {value.checkoutReady && <PhotoSalesCart
        open={open} onClose={() => setOpen(false)} config={value} items={displayedItems}
        onRemove={(id) => setItems((current) => current.filter((item) => item.id !== id))}
      />}
    </PhotoSalesContext.Provider>
  );
};
