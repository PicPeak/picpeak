import i18n from '../../i18n/config';
import { api } from '../../config/api';
export interface Option {
  id: string;
  name: string;
  active: boolean;
  imageId: string | null;
  modelIds?: string[];
  width?: number;
  height?: number;
  unit?: 'mm' | 'cm' | 'in';
}
export interface Attribute {
  id: string;
  name: string;
  groupId: string;
  optionIds: string[];
  required: boolean;
  multiple: boolean;
  addOn: boolean;
  dependsOn: { attributeId: string; optionIds: string[] }[];
  options: Option[];
}
export interface LibraryGroup {
  id: string;
  name: string;
  kind: 'choice' | 'size' | 'colour';
  options: Option[];
}
export interface ProductType {
  id: string;
  name: string;
  active: boolean;
  attributes: Attribute[];
}
export interface Product {
  id: string;
  name: string;
  description: string;
  active: boolean;
  models?: Option[];
  typeId?: string;
  attributes?: Attribute[];
  colours?: Option[];
  version?: string;
}
export interface Catalogue {
  revision: number;
  products: Product[];
  library?: LibraryGroup[];
  types?: ProductType[];
}
export interface Choice {
  schemaVersion: number;
  productVersion: string;
  attributes?: {
    id: string;
    name: string;
    addOn: boolean;
    options: Pick<
      Option,
      'id' | 'name' | 'imageId' | 'width' | 'height' | 'unit'
    >[];
  }[];
  product: { id: string; name: string };
  model?: Pick<Option, 'id' | 'name' | 'imageId'>;
  colour?: Pick<Option, 'id' | 'name' | 'imageId'>;
}
export interface Offer {
  customerId?: number | null;
  cataloguePresetId?: number | null;
  showPrices?: boolean;
  pricing?: {
    currency: string;
    baseUnitPriceMinor: number;
    surcharges: {
      attributeId: string;
      optionId: string;
      amountMinor: number;
    }[];
  } | null;
  id: string;
  productId: string;
  enabled: boolean;
  revision: number;
  status: 'draft' | 'submitted' | 'locked';
  selection: Choice | null;
  product?: Product | null;
  needsReview?: boolean;
  updatedAt: string;
}
export function errorMessage(error: unknown) {
  const e = error as {
    response?: { data?: { error?: string } };
    message?: string;
  };
  return (
    e.response?.data?.error || e.message || i18n.t('common.retry', 'Retry')
  );
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
    update: {
      enabled?: boolean;
      action?: 'lock' | 'unlock';
      cataloguePresetId?: number | null;
      showPrices?: boolean;
      customerId?: number | null;
    },
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
