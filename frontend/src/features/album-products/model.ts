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
  hex?: string;
}
/** What an attribute is in a guided album; its options stay catalogue data. */
export type AttributeRole = 'material' | 'colour' | 'format' | 'size';
export interface Attribute {
  id: string;
  name: string;
  groupId: string;
  optionIds: string[];
  required: boolean;
  multiple: boolean;
  addOn: boolean;
  dependsOn: { attributeId: string; optionIds: string[] }[];
  role?: AttributeRole;
  /** Sizes measure the open album, two pages side by side. */
  spread?: boolean;
  /** Which options of the parent attribute allow each option here. An option
   *  without an entry is offered with all of them. */
  availableWhen?: { attributeId: string; options: Record<string, string[]> };
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
  heroImageId?: string | null;
  guided?: GuidedSettings;
}
export type PhotoRoleKey = 'cover' | 'poster';
export interface GuidedSettings {
  clientFinal: boolean;
  photoRoles: { key: PhotoRoleKey; min: number; max: number }[];
}
export interface ChosenPhoto {
  id: number;
  /** Studio only: a client gets the reference to its picture, nothing else. */
  filename?: string;
  originalFilename?: string | null;
  available?: boolean;
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
    role?: AttributeRole;
    options: Pick<
      Option,
      'id' | 'name' | 'imageId' | 'width' | 'height' | 'unit' | 'hex'
    >[];
  }[];
  product: { id: string; name: string };
  model?: Pick<Option, 'id' | 'name' | 'imageId'>;
  colour?: Pick<Option, 'id' | 'name' | 'imageId'>;
  photoRoles?: { key: PhotoRoleKey; photos: ChosenPhoto[] }[];
  clientFinal?: boolean;
  confirmedAt?: string;
}
export interface OfferHistoryEntry {
  id: string;
  revision: number;
  status: Offer['status'];
  actor_type: string;
  actor_name: string | null;
  created_at: string;
}
/** `?album=` value that opens the album choice when no one album is meant. */
export const CHOOSE_ALBUM = 'choose';
/** A client-final selection the client can no longer change. */
export const isConfirmed = (offer: Pick<Offer, 'status' | 'selection'>) =>
  offer.status === 'locked' ||
  (offer.status === 'submitted' && !!offer.selection?.clientFinal);
export interface Offer {
  // A contact whose login may look at the gallery but not decide for the customer.
  readOnly?: boolean;
  customerId?: number | null;
  releasedCustomerId?: number | null;
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
      .get<{
        catalogue: Catalogue;
        offers: Offer[];
        customers?: { id: number; name: string }[];
      }>(`/admin/album-products/events/${eventId}`)
      .then((r) => r.data),
  assign: (eventId: number, productId: string, customerId?: number) =>
    api
      .post<Offer>(`/admin/album-products/events/${eventId}/offers`, {
        productId,
        ...(customerId ? { customerId } : {}),
      })
      .then((r) => r.data),
  history: (eventId: number, offerId: string) =>
    api
      .get<OfferHistoryEntry[]>(
        `/admin/album-products/events/${eventId}/offers/${offerId}/history`,
      )
      .then((r) => r.data),
  update: (
    eventId: number,
    offer: Offer,
    update: {
      enabled?: boolean;
      action?: 'lock' | 'unlock' | 'reopen';
      cataloguePresetId?: number | null;
      showPrices?: boolean;
      customerId?: number | null;
      releasedCustomerId?: number | null;
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
