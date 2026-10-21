import { api } from '../../config/api';
export interface Option {
  id: string;
  name: string;
  active: boolean;
  imageId: string | null;
  modelIds?: string[];
}
export interface Product {
  id: string;
  name: string;
  description: string;
  active: boolean;
  models: Option[];
  colours: Option[];
  version?: string;
}
export interface Catalogue {
  revision: number;
  products: Product[];
}
export interface Choice {
  schemaVersion: number;
  productVersion: string;
  product: { id: string; name: string };
  model: Pick<Option, 'id' | 'name' | 'imageId'>;
  colour: Pick<Option, 'id' | 'name' | 'imageId'>;
}
export interface Offer {
  id: string;
  productId: string;
  enabled: boolean;
  revision: number;
  status: 'draft' | 'submitted' | 'locked';
  selection: Choice | null;
  product?: Product | null;
  updatedAt: string;
}
export function errorMessage(error: unknown) {
  const e = error as {
    response?: { data?: { error?: string } };
    message?: string;
  };
  return e.response?.data?.error || e.message || 'Please try again.';
}
export const albumProducts = {
  catalogue: () =>
    api.get<Catalogue>('/admin/album-products/catalogue').then((r) => r.data),
  save: (value: Catalogue) =>
    api
      .put<Catalogue>('/admin/album-products/catalogue', value)
      .then((r) => r.data),
  upload: (file: File) =>
    api
      .post<{ id: string }>('/admin/album-products/images', file, {
        headers: { 'Content-Type': 'application/octet-stream' },
      })
      .then((r) => r.data),
  event: (eventId: number) =>
    api
      .get<{ catalogue: Catalogue; offers: Offer[] }>(
        `/admin/album-products/events/${eventId}`,
      )
      .then((r) => r.data),
  assign: (eventId: number, productId: string) =>
    api
      .post<Offer>(`/admin/album-products/events/${eventId}/offers`, {
        productId,
      })
      .then((r) => r.data),
  update: (
    eventId: number,
    offer: Offer,
    update: { enabled?: boolean; action?: 'lock' | 'unlock' },
  ) =>
    api
      .put<Offer>(
        `/admin/album-products/events/${eventId}/offers/${offer.id}`,
        {
          revision: offer.revision,
          mutationId: crypto.randomUUID(),
          ...update,
        },
      )
      .then((r) => r.data),
  client: (slug: string) =>
    api
      .get<{ offers: Offer[] }>(`/gallery/${slug}/album-products`)
      .then((r) => r.data.offers),
};
