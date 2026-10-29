import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../config/api';
import { Button } from '../../components/common';
import type { Photo } from '../../types';
import { formatMoneyMinor } from '../../utils/money';
import { errorMessage } from '../album-products/model';
import { ChoiceSummary } from '../album-products/ConfigurationPicker';
import { CropEditor, CropPreview } from './CropEditor';
import type { Variant, CartItem, Crop, Delivery, Order } from './model';
type Offers = { variants: Variant[]; countries: string[]; policy: string; basketScope: string };
const whole: Crop = { x: 0, y: 0, width: 1, height: 1 };
export function GalleryPrintShop({ slug, photos }: { slug: string; photos: Photo[] }) {
  const { t } = useTranslation(), root = `/gallery/${slug}/print-sales`;
  const [offers, setOffers] = useState<Offers>(), [cart, setCart] = useState<CartItem[]>([]),
    [photoId, setPhotoId] = useState(0), [variantId, setVariantId] = useState(''), [quantity, setQuantity] = useState(1),
    [crop, setCrop] = useState<Crop>(whole), [fit, setFit] = useState<'cover' | 'contain'>('cover'),
    [error, setError] = useState(''), [busy, setBusy] = useState(false), [quote, setQuote] = useState<Order>(),
    [approved, setApproved] = useState(false), [orders, setOrders] = useState<Order[]>([]), [editing, setEditing] = useState<number>(),
    [delivery, setDelivery] = useState<Delivery>({ name: '', line1: '', line2: '', city: '', region: '', postalCode: '', country: '' });
  const attempt = useRef<{ fingerprint: string; id: string }>();
  useEffect(() => {
    let active = true;
    api.get<Offers>(root).then(r => {
      if (!active) return;
      setOffers(r.data); setVariantId(r.data.variants[0]?.id || '');
      setDelivery(d => ({ ...d, country: r.data.countries[0] || '' }));
      try { const saved = JSON.parse(sessionStorage.getItem(`print-basket:${r.data.basketScope}`) || '[]');
        if (Array.isArray(saved) && saved.length <= 20) setCart(saved); } catch { /* A private browser may disable storage. */ }
    }).catch(e => { if (active && ![401, 403, 404].includes(e.response?.status)) setError(errorMessage(e)); });
    return () => { active = false; };
  }, [root]);
  useEffect(() => { if (offers) { try { sessionStorage.setItem(`print-basket:${offers.basketScope}`, JSON.stringify(cart)); } catch { /* Basket remains in memory. */ } } }, [cart, offers]);
  useEffect(() => {
    if (!offers) return;
    let active = true;
    const load = () => api.get<{ orders: Order[] }>(`${root}/orders`).then(r => { if (active) setOrders(r.data.orders); }).catch(() => {});
    load(); const timer = setInterval(load, 20000);
    return () => { active = false; clearInterval(timer); };
  }, [root, offers]);
  const photo = photos.find(p => p.id === photoId), variant = offers?.variants.find(v => v.id === variantId);
  const selectedFit = variant?.fitModes.includes(fit) ? fit : variant?.fitModes[0] || 'cover';
  const prepare = async () => {
    setBusy(true); setError(''); setApproved(false);
    const payload = { items: cart, delivery }, fingerprint = JSON.stringify(payload);
    if (attempt.current?.fingerprint !== fingerprint) attempt.current = { fingerprint, id: crypto.randomUUID() };
    try { setQuote((await api.post<Order>(`${root}/quotes`, { ...payload, requestId: attempt.current.id })).data); }
    catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  };
  const accept = async () => {
    if (!quote) return; setBusy(true); setError('');
    try {
      const row = (await api.post<Order>(`${root}/orders/${quote.id}/accept`, { snapshotHash: quote.snapshotHash, acknowledgeSelection: approved })).data;
      setOrders(rows => [row, ...rows.filter(o => o.id !== row.id)]); setCart([]); setQuote(undefined); attempt.current = undefined;
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  };
  if (!offers?.variants.length && !orders.length && !error) return null;
  return <details className="max-w-7xl mx-auto px-4 py-6 space-y-4 text-text-primary bg-background">
    <summary className="cursor-pointer text-lg font-semibold">{t('printSales.shop', 'Order photographic prints')}</summary>
    <p>{t('printSales.invoiceJourney', 'Choose your photographs and crops, then confirm your order. The studio will send an invoice and check the prepared files before ordering from the lab.')}</p>
    {!quote && <fieldset disabled={busy} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <label>{t('printSales.photograph', 'Photograph')}<select className="input w-full" value={photoId} onChange={e => { setPhotoId(Number(e.target.value)); setEditing(undefined); }}>
          <option value={0}>{t('printSales.choosePhoto', 'Choose a photograph')}</option>
          {photos.filter(p => p.media_type !== 'video').map(p => <option key={p.id} value={p.id}>{p.original_filename || p.filename}</option>)}</select></label>
        <label>{t('printSales.variant', 'Size and finish')}<select className="input w-full" value={variantId} onChange={e => { setVariantId(e.target.value); setEditing(undefined); }}>
          {offers?.variants.map(v => <option key={v.id} value={v.id}>{v.selection.product.name} · {v.selection.attributes?.flatMap(a => a.options.map(o => o.name)).join(' / ')} · {formatMoneyMinor(v.unitPriceMinor, v.currency)}</option>)}</select></label>
      </div>
      <p>{t('printSales.priceBasis', 'Variant prices are before tax. Review the final total, including tax and delivery, before confirming your order.')}</p>
      {variant && photo && <>
        <p><ChoiceSummary choice={variant.selection} /></p>
        <label>{t('printSales.fit', 'Photo placement')}<select className="input" value={selectedFit} onChange={e => { setFit(e.target.value as 'cover' | 'contain'); setCrop(whole); }}>
          {variant.fitModes.map(f => <option key={f} value={f}>{f === 'cover' ? t('printSales.cover', 'Crop to fill') : t('printSales.fitWhole', 'Fit whole photograph')}</option>)}</select></label>
        <CropEditor key={`${photo.id}:${variant.id}:${selectedFit}:${editing}`} src={photo.preview_url || photo.url} slug={slug}
          ratio={variant.artwork.widthMm / variant.artwork.heightMm} fit={selectedFit} background={variant.background} value={crop} onChange={setCrop} resetOnLoad={editing === undefined || crop === whole} />
        <label>{t('printSales.quantity', 'Copies')}<input className="input ml-2" type="number" min={1} max={100} value={quantity} onChange={e => setQuantity(Number(e.target.value))} /></label>
        <Button disabled={(cart.length >= 20 && editing === undefined) || !Number.isInteger(quantity) || quantity < 1 || quantity > 100} onClick={() => {
          const item: CartItem = { photoId, profileId: variant.id, quantity, crop: selectedFit === 'contain' ? whole : crop, fit: selectedFit };
          setCart(editing === undefined ? [...cart, item] : cart.map((i, n) => n === editing ? item : i)); setEditing(undefined);
        }}>{editing === undefined ? t('printSales.addToBasket', 'Add to basket') : t('printSales.saveCrop', 'Update basket item')}</Button>
      </>}
      {!!cart.length && <section className="space-y-3"><h3 className="font-semibold">{t('printSales.basket', 'Your basket')}</h3>
        {cart.map((item, n) => <div className="flex flex-wrap gap-3 items-center" key={n}>
          {photos.find(p => p.id === item.photoId) && <CropPreview src={photos.find(p => p.id === item.photoId)!.preview_url || photos.find(p => p.id === item.photoId)!.url}
            slug={slug} crop={item.crop} fit={item.fit} background={offers?.variants.find(v => v.id === item.profileId)?.background} ratio={(offers?.variants.find(v => v.id === item.profileId)?.artwork.widthMm || 1) / (offers?.variants.find(v => v.id === item.profileId)?.artwork.heightMm || 1)} />}
          <span>{photos.find(p => p.id === item.photoId)?.filename || `#${item.photoId}`} · {offers?.variants.find(v => v.id === item.profileId)?.selection.product.name}</span>
          {offers?.variants.find(v => v.id === item.profileId) && <ChoiceSummary choice={offers.variants.find(v => v.id === item.profileId)!.selection} />}
          <label>{t('printSales.quantity', 'Copies')}<input className="input w-20" type="number" min={1} max={100} value={item.quantity}
            onChange={e => setCart(cart.map((i, k) => k === n ? { ...i, quantity: Number(e.target.value) } : i))} /></label>
          <button className="underline" onClick={() => setCart(cart.filter((_, i) => i !== n))}>{t('common.remove', 'Remove')}</button>
          <button className="underline" onClick={() => { setEditing(n); setPhotoId(item.photoId); setVariantId(item.profileId); setQuantity(item.quantity); setCrop(item.crop); setFit(item.fit); }}>{t('printSales.editCrop', 'Edit crop')}</button>
        </div>)}
        <h3 className="font-semibold">{t('printSales.deliveryAddress', 'Delivery address')}</h3>
        <div className="grid gap-3 sm:grid-cols-2">{(['name', 'line1', 'line2', 'city', 'region', 'postalCode'] as const).map(key => <label key={key}>
          {t(`printSales.address.${key}`, { name: 'Recipient name', line1: 'Address line 1', line2: 'Address line 2 (optional)', city: 'City', region: 'Region (optional)', postalCode: 'Postal code' }[key])}
          <input className="input w-full" value={delivery[key]} maxLength={200} onChange={e => setDelivery({ ...delivery, [key]: e.target.value })} /></label>)}</div>
        <label>{t('printSales.country', 'Country')}<select className="input" value={delivery.country} onChange={e => setDelivery({ ...delivery, country: e.target.value })}>
          {offers?.countries.map(c => <option key={c} value={c}>{c}</option>)}</select></label>
        <Button onClick={prepare}>{t('printSales.reviewOrder', 'Review selections and final total')}</Button>
      </section>}
    </fieldset>}
    {quote && <section className="space-y-4" aria-label={t('printSales.orderReview', 'Review print order')}>
      <ul>{quote.items?.map((i, n) => <li key={n} className="flex flex-wrap gap-3 items-center mb-3">
        {photos.find(p => p.id === i.photoId) && <CropPreview src={photos.find(p => p.id === i.photoId)!.preview_url || photos.find(p => p.id === i.photoId)!.url}
          slug={slug} crop={i.crop} fit={i.fit} background={i.background} ratio={(i.artwork?.widthMm || 2) / (i.artwork?.heightMm || 3)} />}
        {i.filename} · <ChoiceSummary choice={i.selection} /> × {i.quantity}</li>)}</ul>
      <p>{t('printSales.net', 'Before tax')}: {formatMoneyMinor(quote.netMinor, quote.currency)} · {t('printSales.tax', 'Tax')}: {formatMoneyMinor(quote.vatMinor, quote.currency)}</p>
      <p className="text-lg font-semibold">{t('printSales.finalTotal', 'Total including delivery and tax')}: {formatMoneyMinor(quote.totalMinor, quote.currency)}</p>
      <p>{quote.delivery && Object.values(quote.delivery).filter(Boolean).join(', ')}</p><p className="whitespace-pre-wrap">{quote.policy}</p>
      <label className="flex gap-3"><input type="checkbox" checked={approved} onChange={e => setApproved(e.target.checked)} />{t('printSales.selectionConsent', 'I confirm these photographs, crops, quantities, prices, delivery details and the buyer policy.')}</label>
      <Button disabled={busy || !approved} onClick={accept}>{t('printSales.confirmInvoice', 'Confirm order and request invoice')}</Button>
      <Button disabled={busy} variant="secondary" onClick={() => { setQuote(undefined); attempt.current = undefined; }}>{t('printSales.editBasket', 'Return to basket')}</Button>
    </section>}
    {orders.filter(o => o.acceptedAt).map(o => <article className="border border-border-token rounded-lg p-4" key={o.id}>
      <h3>{o.status === 'cancelled' ? t('printSales.orderCancelled', 'Order cancelled') : t('printSales.orderConfirmed', 'Order confirmed')} · {o.id.slice(0, 8)}</h3>
      <p>{formatMoneyMinor(o.totalMinor, o.currency)} · {t('printSales.invoiceNumber', 'Invoice')} #{o.invoiceId}</p>
      <p>{o.dispatchedAt ? t('printSales.dispatched', 'Dispatched') : o.submittedAt ? t('printSales.withLab', 'Submitted to the lab') : t('printSales.studioReview', 'The studio is arranging your invoice and checking the artwork.')}</p>
      {o.tracking && <p>{o.tracking}</p>}
    </article>)}
    {error && <p role="alert">{error}</p>}
  </details>;
}
