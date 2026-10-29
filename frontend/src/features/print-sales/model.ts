import { api } from '../../config/api';
import type { Choice, Product } from '../album-products/model';
export type Crop = { x: number; y: number; width: number; height: number };
export type Edges = { top: number; right: number; bottom: number; left: number };
export type ColourSpace = 'srgb' | 'adobe-rgb-1998' | 'display-p3' | 'prophoto-rgb';
export type Output = { format: 'jpeg'; colourSpace: ColourSpace; quality?: number; chromaSubsampling?: '4:4:4' | '4:2:0' }
  | { format: 'png'; colourSpace: ColourSpace; compressionLevel?: number }
  | { format: 'tiff'; colourSpace: ColourSpace; compression?: 'lzw' | 'deflate' | 'none' };
export interface DeliveryZone { id: string; name: string; countries: string[]; cataloguePresetId: number | null }
export interface Profile {
  cataloguePresetId: number;
  definition: {
    id: string; revision: number; enabled: boolean; labReference: string; supplierName?: string; instructions?: string;
    selection: { productId: string; productVersion: string; values: Record<string, string[]> };
    manufacturing: { capability: 'single-photo-rectangle'; trimMm: { width: number; height: number };
      bleedMm: Edges; safeInsetMm: Edges; resolution: { targetDpi: number; minimumDpi: number };
      output: Output; background?: string; fitModes: ('cover' | 'contain')[] };
  };
}
export interface Settings {
  revision: number; profiles: Profile[]; countries: string[]; policy: string; shippingPresetId: number | null;
  shippingZones?: DeliveryZone[];
  products?: Product[]; presets?: { id: number; name: string; product_id: string | null; currency: string }[];
}
export interface Variant {
  id: string; version: string; selection: Choice; artwork: { widthMm: number; heightMm: number };
  fitModes: ('cover' | 'contain')[]; background?: string; currency: string; unitPriceMinor: number;
}
export interface CartItem { photoId: number; profileId: string; quantity: number; crop: Crop; fit: 'cover' | 'contain' }
export interface Delivery { name: string; line1: string; line2: string; city: string; region: string; postalCode: string; country: string }
export interface Order {
  id: string; status: string; renderStatus: string; invoiceId: number | null; snapshotHash: string; artworkVersion: string | null;
  currency: string; totalMinor: number; netMinor: number; vatMinor: number; delivery?: Delivery; policy: string;
  buyerEmail?: string; acceptedAt: string | null; reviewedAt: string | null; submittedAt: string | null; dispatchedAt: string | null;
  supplierReference: string | null; tracking: string | null; needsAttention: boolean; purgedAt: string | null;
  items?: { photoId: number; filename: string; quantity: number; crop: Crop; fit: string; selection: Choice;
    artwork?: { widthMm: number; heightMm: number }; background?: string; unitPriceMinor: number }[];
}
export const printSales = {
  settings: () => api.get<Settings>('/admin/print-sales/settings').then(r => r.data),
  save: (settings: Settings) => api.put<Settings>('/admin/print-sales/settings', settings).then(r => r.data),
  orders: (offset = 0) => api.get<{ orders: Order[] }>(`/admin/print-sales/orders?offset=${offset}`).then(r => r.data.orders),
  action: (id: string, action: string, details: Record<string, unknown> = {}) =>
    api.post<Order>(`/admin/print-sales/orders/${id}/actions`, { action, ...details }).then(r => r.data),
};
