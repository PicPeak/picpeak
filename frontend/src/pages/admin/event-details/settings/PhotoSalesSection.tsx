/**
 * Photo sales section of the gallery Settings tab.
 *
 * The pricing toggle and its inputs: free photo count, price per extra
 * photo and the access window for purchased downloads. Saving is handled by
 * the shared settings draft (useEventSettingsDraft) — this component only
 * edits the draft. The backend re-generates the one-time promo code and the
 * Snipcart discount when these values change (adminEvents/crud.js).
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Euro } from 'lucide-react';
import { Input } from '../../../../components/common';
import { inputClass, labelClass, SectionCard } from './sections';
import type { EventFields } from './draft';
import { PhotoSalesStoreNotice } from '../../../../features/photo-sales/PhotoSalesStoreNotice';
import { usePhotoOrders } from '../../../../features/photo-sales/usePhotoOrders';

export const PhotoSalesSection: React.FC<{
  f: EventFields;
  set: (patch: Partial<EventFields>) => void;
  eventId: number;
}> = ({ f, set, eventId }) => {
  const { t } = useTranslation();
  // The store check rides on the orders query (shared with the Orders tab).
  const { data: orders } = usePhotoOrders(eventId, f.is_priced);
  return (
    <SectionCard
      title={t('photoSales.sectionTitle', 'Photo sales')}
      description={t(
        'photoSales.sectionDescription',
        'Sell individual photo downloads: the first free photos are granted through a one-time promo code shown on the gallery.'
      )}
    >
      <label className="inline-flex items-center gap-3 text-sm font-medium text-body">
        <input
          type="checkbox"
          checked={f.is_priced}
          onChange={(e) => set({ is_priced: e.target.checked })}
          className="rounded border-line-strong text-accent focus:ring-accent"
        />
        {t('photoSales.pricedGallery', 'Priced gallery')}
      </label>

      {f.is_priced && <PhotoSalesStoreNotice store={orders?.store} />}

      {f.is_priced && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label className={labelClass} htmlFor="photo-sales-free">{t('photoSales.freePhotos', 'Free photos')}</label>
            <Input
              id="photo-sales-free"
              type="number"
              min={0}
              className={inputClass}
              value={f.free_photo_count}
              onChange={(e) => set({ free_photo_count: Math.max(0, Number(e.target.value || 0)) })}
            />
          </div>
          <div>
            <label className={labelClass} htmlFor="photo-sales-price">
              <span className="inline-flex items-center gap-1">
                <Euro className="w-3.5 h-3.5" />
                {t('photoSales.pricePerPhoto', 'Price per extra photo')}
              </span>
            </label>
            <Input
              id="photo-sales-price"
              type="number"
              min={0}
              step="0.01"
              className={inputClass}
              value={f.photo_price}
              onChange={(e) => set({ photo_price: Number(e.target.value || 0) })}
            />
          </div>
          <div>
            <label className={labelClass} htmlFor="photo-sales-days">{t('photoSales.accessDays', 'Access days')}</label>
            <Input
              id="photo-sales-days"
              type="number"
              min={1}
              className={inputClass}
              value={f.purchase_access_days}
              onChange={(e) => set({ purchase_access_days: Math.max(1, Number(e.target.value || 30)) })}
            />
          </div>
        </div>
      )}
    </SectionCard>
  );
};
