import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AuthenticatedImage } from '../../components/common/AuthenticatedImage';
import type { Photo } from '../../types';
import { formatMoneyMinor } from '../../utils/money';
import { CropEditor } from './CropEditor';
import { QuantityControl } from './QuantityControl';
import { SpatialPreview } from './SpatialPreview';
import type { Variant } from './model';
import { choices, dimensions, newDraft, photoName, photoSource, whole, type Draft } from './shopping';

export function PrintEditor({ slug, photos, variants, drafts, active, setActive, update, onValidity, onPreviewReady, applyAll, chooseMore, editing }: {
  slug: string; photos: Photo[]; variants: Variant[]; drafts: Draft[]; active: number; setActive: (n: number) => void;
  update: (draft: Partial<Draft>) => void; onValidity: (valid: boolean) => void; onPreviewReady: (ready: boolean) => void; applyAll: () => void; chooseMore: () => void; editing: boolean;
}) {
  const { t } = useTranslation(), draft = drafts[active], variant = variants.find(v => v.id === draft?.profileId), photo = photos.find(p => p.id === draft?.photoId);
  const [product, setProduct] = useState('');
  useEffect(() => { setProduct(''); }, [draft?.photoId, draft?.profileId]);
  if (!draft || !variant || !photo) return <p role="alert">{t('printSales.refreshSelection', 'This photograph or product is no longer available. Return to your basket and remove it or choose another option.')}</p>;
  const products = [...new Map(variants.map(v => [v.selection.product.id, v.selection.product.name])).entries()];
  const shownProduct = product || variant.selection.product.id;
  return <div className="space-y-5">
    {drafts.length > 1 && <div className="print-filmstrip" aria-label={t('printSales.selectedPhotos', 'Selected photographs')}>{drafts.map((d, n) => {
      const p = photos.find(p => p.id === d.photoId);
      return p && <button type="button" key={`${d.photoId}:${n}`} className="print-film-photo" aria-pressed={active === n} onClick={() => { if (n !== active) { setActive(n); onValidity(true); } }}>
        <AuthenticatedImage src={photoSource(p)} slug={slug} isGallery alt={photoName(p)} className="w-full h-full object-cover" /><span aria-hidden="true">{d.ready ? '✓' : n + 1}</span>
      </button>;
    })}</div>}
    <div className="print-editor-grid">
      <section className="space-y-4 min-w-0"><h3 className="font-semibold break-words">{photoName(photo)}</h3>
        <CropEditor key={`${draft.photoId}:${draft.profileId}:${draft.fit}`} src={photoSource(photo)} slug={slug} ratio={variant.artwork.widthMm / variant.artwork.heightMm}
          value={draft.crop} fit={draft.fit} background={variant.background} bleed={variant.bleedMm} artwork={variant.artwork} resetOnLoad={!draft.ready}
          onChange={crop => update({ crop })} onReady={ready => { onPreviewReady(ready); if (ready && !draft.ready) update({ ready: true }); }} />
        <SpatialPreview variant={variant} src={photoSource(photo)} slug={slug} crop={draft.crop} fit={draft.fit} />
      </section>
      <section className="space-y-5 min-w-0">
        {products.length > 1 && <div className="print-segment flex-wrap" aria-label={t('printSales.productGroup', 'Print product')}>{products.map(([id, name]) => <button type="button" key={id} aria-pressed={shownProduct === id} onClick={() => setProduct(id)}>{name}</button>)}</div>}
        <fieldset><legend className="font-semibold mb-2">{t('printSales.variant', 'Size and finish')}</legend><div className="print-variant-grid">{variants.filter(v => v.selection.product.id === shownProduct).map(v => <button type="button" key={v.id}
          className="print-variant" aria-pressed={variant.id === v.id} onClick={() => { if (v.id !== draft.profileId) update(newDraft(draft.photoId, v, draft)); }}>
          <span className="print-size-icon" aria-hidden="true"><i style={{ aspectRatio: v.artwork.widthMm / v.artwork.heightMm }} /></span>
          <span className="font-semibold">{dimensions(v)}</span>{choices(v, true) && <span className="text-xs text-muted">{choices(v, true)}</span>}
          <span>{formatMoneyMinor(v.unitPriceMinor, v.currency)}</span>
        </button>)}</div></fieldset>
        <p className="text-xs text-muted">{t('printSales.priceBasis', 'Variant prices are before tax. Review the final total, including tax and delivery, before confirming your order.')}</p>
        <fieldset><legend className="font-semibold mb-2">{t('printSales.fit', 'Photo placement')}</legend><div className="print-segment">{variant.fitModes.map(f => <button key={f} type="button" aria-pressed={draft.fit === f}
          onClick={() => { if (f !== draft.fit) update({ ...draft, fit: f, crop: { ...whole }, ready: false }); }}>
          {f === 'cover' ? t('printSales.cover', 'Crop to fill') : t('printSales.fitWhole', 'Fit whole photograph')}
        </button>)}</div></fieldset>
        <div><p className="font-semibold mb-2">{t('printSales.quantity', 'Copies')}</p><QuantityControl key={`${draft.photoId}:${draft.profileId}`} value={draft.quantity} label={t('printSales.copiesPhoto', 'Copies for this photograph')} onChange={quantity => update({ ...draft, quantity })} onValidity={onValidity} /></div>
        {drafts.length > 1 && <button type="button" className="print-text-button" onClick={applyAll}>{t('printSales.applyOptions', 'Use this size, placement and copy count for all selected photos')}</button>}
        {!editing && <button type="button" className="print-text-button" onClick={chooseMore}>{t('printSales.selectMore', 'Select more photographs')}</button>}
      </section>
    </div>
  </div>;
}
