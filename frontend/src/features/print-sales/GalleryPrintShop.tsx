import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocalizedDate } from '../../hooks/useLocalizedDate';
import { PreparationProgress } from './PreparationProgress';
import { useTranslation } from 'react-i18next';
import { api } from '../../config/api';
import { Button } from '../../components/common';
import { Modal } from '../../components/common/Modal';
import type { Photo } from '../../types';
import { formatMoneyMinor } from '../../utils/money';
import { errorMessage } from '../album-products/model';
import { ChoiceSummary } from '../album-products/ConfigurationPicker';
import { CropPreview } from './CropEditor';
import { PhotoPicker } from './PhotoPicker';
import { PrintEditor } from './PrintEditor';
import { PrintSalesContext, usePrintSales } from './PrintSalesContext';
import { QuantityControl } from './QuantityControl';
import type { Variant, Delivery, Order, Quote } from './model';
import { MAX_ITEMS, choices, dimensions, isPhotograph, newDraft, photoName, photoSource, readBasket, requestItem, type BasketLine, type Draft } from './shopping';
import './print-shopping.css';

type Offers = { variants: Variant[]; countries: string[]; policy: string; basketScope: string };
type View = 'photos' | 'editor' | 'basket';
const addressLabels = { name: 'Recipient name', line1: 'Address line 1', line2: 'Address line 2 (optional)', city: 'City', region: 'Region (optional)', postalCode: 'Postal code' };
export function PrintSalesProvider({ slug, photos, enabled = true, selectedPhotoIds, children }: {
  slug: string; photos: Photo[]; enabled?: boolean; selectedPhotoIds?: Set<number>; children: ReactNode;
}) {
  // A new gallery gets its own state immediately, including while its offers load.
  return <ShopSession key={`${slug}:${enabled}`} slug={slug} photos={photos} enabled={enabled} selectedPhotoIds={selectedPhotoIds}>{children}</ShopSession>;
}
function ShopSession({ slug, photos, enabled, selectedPhotoIds, children }: {
  slug: string; photos: Photo[]; enabled: boolean; selectedPhotoIds?: Set<number>; children: ReactNode;
}) {
  const queryClient = useQueryClient();
  const { formatDateTime } = useLocalizedDate();
  const { t } = useTranslation(), root = `/gallery/${slug}/print-sales`;
  const [offers, setOffers] = useState<Offers>(), [basket, setBasket] = useState<{ scope: string; lines: BasketLine[] }>({ scope: '', lines: [] }),
    [view, setView] = useState<View>(), [drafts, setDrafts] = useState<Draft[]>([]), [active, setActive] = useState(0),
    [picked, setPicked] = useState<number[]>([]), [editing, setEditing] = useState<string>(), [previewReady, setPreviewReady] = useState(false),
    [validDraft, setValidDraft] = useState(true), [invalidLines, setInvalidLines] = useState<Set<string>>(new Set()),
    [error, setError] = useState(''), [busy, setBusy] = useState(false), [initialQuote, setQuote] = useState<Quote>(), [quoteId, setQuoteId] = useState<string>(),
    [approved, setApproved] = useState(false), [deadlineReached, setDeadlineReached] = useState(false), [orders, setOrders] = useState<Order[]>([]),
    [delivery, setDelivery] = useState<Delivery>({ name: '', line1: '', line2: '', city: '', region: '', postalCode: '', country: '' });
  const attempt = useRef<{ fingerprint: string; id: string }>(), loadSequence = useRef(0), scope = useRef(''), orderSequence = useRef(0);
  const draftCache = useRef(new Map<number, Draft>());
  const cart = basket.lines, photographs = photos.filter(isPhotograph);
  const quoteKey = ['print-preparation', root, offers?.basketScope, quoteId];
  const preparation = useQuery({ queryKey: quoteKey,
    queryFn: ({ signal }) => api.get<Quote>(`${root}/orders/${quoteId}`, { signal }).then(r => r.data),
    enabled: !!offers && !!quoteId && view === 'basket',
    initialData: initialQuote?.id === quoteId ? initialQuote : undefined,
    retry: false,
    refetchInterval: query => query.state.status === 'error' || ['ready', 'failed', 'expired'].includes(query.state.data?.preparation?.stage || '') ? false : 2000 });
  const quote = preparation.data;
  const expired = !!quote && !quote.acceptedAt && (deadlineReached || !(Date.parse(quote.expiresAt) > Date.now()));
  const ready = quote?.status === 'quoted' && quote.renderStatus === 'ready' && quote.preparation.stage === 'ready' && !preparation.isError && !expired;
  useEffect(() => {
    setDeadlineReached(false);
    if (!quote || quote.acceptedAt || view !== 'basket') return;
    const delay = Date.parse(quote.expiresAt) - Date.now();
    if (!Number.isFinite(delay) || delay <= 0) { setDeadlineReached(true); return; }
    const timer = setTimeout(() => { setDeadlineReached(true); void preparation.refetch(); }, Math.min(delay, 2147483647));
    const refresh = () => { if (document.visibilityState === 'visible') { setDeadlineReached(Date.parse(quote.expiresAt) <= Date.now()); void preparation.refetch(); } };
    window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', refresh);
    return () => { clearTimeout(timer); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
    // Only a new quotation/deadline or opening the review resets this clock.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quote?.id, quote?.expiresAt, quote?.acceptedAt, view]);
  const invalidate = () => {
    void queryClient.cancelQueries({ queryKey: quoteKey });
    setQuote(undefined); setQuoteId(undefined); setApproved(false);
    if (scope.current) { try { sessionStorage.removeItem(`print-preparation:${scope.current}`); } catch { /* Memory-only session. */ } }
  };
  const loadOffers = async () => {
    const sequence = ++loadSequence.current;
    try {
      const next = (await api.get<Offers>(root)).data;
      if (sequence !== loadSequence.current) return;
      if (scope.current !== next.basketScope) {
        scope.current = next.basketScope;
        let lines: BasketLine[] = [];
        try { lines = readBasket(sessionStorage.getItem(`print-basket:${next.basketScope}`)); } catch { /* Memory-only basket in private browsers. */ }
        setBasket({ scope: next.basketScope, lines }); setView(undefined); setDrafts([]); draftCache.current.clear(); setEditing(undefined);
        setQuote(undefined);
        let retained: string | undefined;
        try { retained = sessionStorage.getItem(`print-preparation:${next.basketScope}`) || undefined; } catch { /* Memory-only session. */ }
        setQuoteId(retained); setApproved(false); setBusy(false); setOrders([]); setInvalidLines(new Set()); attempt.current = undefined;
        setDelivery({ name: '', line1: '', line2: '', city: '', region: '', postalCode: '', country: next.countries[0] || '' });
      }
      setOffers(next); setError('');
    } catch (e) {
      if (sequence !== loadSequence.current) return;
      const status = (e as { response?: { status: number } }).response?.status;
      if ([401, 403, 404].includes(status || 0)) { setOffers(undefined); setView(undefined); }
      else setError(errorMessage(e));
    }
  };
  useEffect(() => {
    if (enabled) void loadOffers();
    const sequence = loadSequence;
    return () => { sequence.current++; };
    // Session is keyed by gallery and availability; manual refresh uses the same loader.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, root]);
  useEffect(() => {
    if (offers && basket.scope === offers.basketScope) {
      try { sessionStorage.setItem(`print-basket:${basket.scope}`, JSON.stringify(cart)); } catch { /* Keep the basket in memory. */ }
    }
  }, [basket, offers, cart]);
  useEffect(() => {
    if (!offers) return;
    let current = true;
    const load = () => {
      const sequence = ++orderSequence.current, expectedScope = offers.basketScope;
      return api.get<{ orders: Order[] }>(`${root}/orders`).then(r => {
        if (current && sequence === orderSequence.current && scope.current === expectedScope) setOrders(r.data.orders);
      }).catch(() => {});
    };
    void load(); const timer = setInterval(load, 20000);
    return () => { current = false; clearInterval(timer); };
  }, [root, offers]);
  useEffect(() => {
    if (!offers || !quoteId) return;
    try { sessionStorage.setItem(`print-preparation:${offers.basketScope}`, quoteId); } catch { /* Memory-only session. */ }
  }, [offers, quoteId]);
  useEffect(() => {
    if (!quote?.acceptedAt) return;
    orderSequence.current++; setError('');
    setOrders(rows => [quote, ...rows.filter(o => o.id !== quote.id)]);
    // A response lost after acceptance can be recovered without another invoice.
    // Only remove the matching cart; another tab may have saved a new basket.
    if (JSON.stringify(cart.map(requestItem)) === JSON.stringify(quote.items?.map(i => requestItem(i))))
      setBasket(b => ({ ...b, lines: [] }));
    invalidate(); attempt.current = undefined;
    // Handle an accepted result once, including recovery after a page refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quote?.id, quote?.acceptedAt]);
  const changeCart = (lines: BasketLine[]) => { setBasket(b => ({ ...b, lines })); invalidate(); };
  useEffect(() => { drafts.forEach(d => draftCache.current.set(d.photoId, d)); }, [drafts]);
  const updateDraft = (patch: Partial<Draft>) => setDrafts(rows => rows.map((d, n) => n === active ? { ...d, ...patch } : d));
  const start = (id?: number) => {
    if (quoteId) { setView('basket'); return; }
    if (!offers?.variants.length) return;
    setError(''); setEditing(undefined); setValidDraft(true); setPreviewReady(false); setActive(0);
    if (id && photographs.some(p => p.id === id)) {
      const saved = draftCache.current.get(id), v = offers.variants.find(v => v.id === saved?.profileId) || offers.variants[0];
      setDrafts([saved && saved.profileId === v.id && saved.version === v.version ? saved : newDraft(id, v)]); setView('editor');
    } else {
      setDrafts([]); setPicked(photographs.filter(p => selectedPhotoIds?.has(p.id)).map(p => p.id)); setView('photos');
    }
  };
  const chooseMore = () => { setPicked(drafts.map(d => d.photoId)); setView('photos'); };
  const continueSelection = () => {
    if (!offers || !picked.length || picked.length + cart.length > MAX_ITEMS) return;
    const previous = drafts[active], v = offers.variants.find(v => v.id === previous?.profileId) || offers.variants[0];
    setDrafts(picked.map(id => drafts.find(d => d.photoId === id) || newDraft(id, v, previous)));
    setActive(0); setPreviewReady(false); setValidDraft(true); setView('editor');
  };
  const add = () => {
    if (!offers || !validDraft || !previewReady || drafts.some(d => !d.ready) || (!editing && cart.length + drafts.length > MAX_ITEMS)) return;
    const lines = drafts.map(d => ({ ...requestItem(d), lineId: editing || crypto.randomUUID(), version: offers.variants.find(v => v.id === d.profileId)!.version }));
    changeCart(editing ? cart.map(i => i.lineId === editing ? lines[0] : i) : [...cart, ...lines]);
    setInvalidLines(new Set()); setEditing(undefined); setView('basket');
  };
  const edit = (item: BasketLine) => {
    const variant = offers?.variants.find(v => v.id === item.profileId);
    setEditing(item.lineId); setDrafts([{ ...requestItem(item), ready: !item.version || item.version === variant?.version, version: variant?.version }]); setActive(0); setPreviewReady(false); setValidDraft(true); setView('editor'); setError('');
  };
  const stale = cart.some(i => !photographs.some(p => p.id === i.photoId) || !offers?.variants.some(v => v.id === i.profileId && (!i.version || v.version === i.version)));
  const prepare = async () => {
    if (!cart.length || invalidLines.size || stale) return;
    const sequence = loadSequence.current;
    setBusy(true); setError(''); setApproved(false);
    const payload = { items: cart.map(requestItem), delivery }, fingerprint = JSON.stringify(payload);
    if (attempt.current?.fingerprint !== fingerprint) attempt.current = { fingerprint, id: crypto.randomUUID() };
    try { const next = (await api.post<Quote>(`${root}/quotes`, { ...payload, requestId: attempt.current.id })).data;
      if (sequence !== loadSequence.current) return;
      setQuote(next); setQuoteId(next.id); }
    catch (e) {
      if (sequence !== loadSequence.current) return;
      // Only a request that never arrived may reuse its id; a refused one is spent.
      if ((e as { response?: unknown }).response) attempt.current = undefined;
      setError(errorMessage(e));
    } finally { if (sequence === loadSequence.current) setBusy(false); }
  };
  const accept = async () => {
    if (!quote || !approved || !ready) return;
    const expectedScope = scope.current;
    setBusy(true); setError('');
    try {
      const row = (await api.post<Order>(`${root}/orders/${quote.id}/accept`, { snapshotHash: quote.snapshotHash, acknowledgeSelection: approved })).data;
      if (scope.current !== expectedScope) return;
      orderSequence.current++;
      setOrders(rows => [row, ...rows.filter(o => o.id !== row.id)]); changeCart([]); attempt.current = undefined;
    } catch (e) {
      if (scope.current !== expectedScope) return;
      // A refused quotation stays refused, so reviewing again needs a new id.
      if ((e as { response?: { status?: number } }).response?.status === 409) attempt.current = undefined;
      setError(errorMessage(e));
      void preparation.refetch();
    } finally { if (scope.current === expectedScope) setBusy(false); }
  };
  const discard = async () => {
    if (!quoteId) return;
    const expectedScope = scope.current;
    setBusy(true); setError('');
    await queryClient.cancelQueries({ queryKey: quoteKey });
    try {
      await api.post(`${root}/orders/${quoteId}/discard`);
      if (scope.current !== expectedScope) return;
      invalidate(); attempt.current = undefined;
    } catch (e) { if (scope.current === expectedScope) { setError(errorMessage(e)); void preparation.refetch(); } }
    finally { if (scope.current === expectedScope) setBusy(false); }
  };
  const available = !!offers?.variants.length;
  const estimates = new Map<string, number>();
  const estimatedItems = view === 'editor' ? drafts : cart;
  for (const item of estimatedItems) {
    const v = offers?.variants.find(v => v.id === item.profileId);
    if (v) estimates.set(v.currency, (estimates.get(v.currency) || 0) + v.unitPriceMinor * item.quantity);
  }
  const estimateLabel = [...estimates].map(([currency, total]) => formatMoneyMinor(total, currency)).join(' + ');

  const footer = view === 'photos' ? <>
    <Button variant="secondary" onClick={() => setView('basket')}>{t('common.back', 'Back')}</Button>
    <Button disabled={!picked.length || picked.length + cart.length > MAX_ITEMS} onClick={continueSelection}>{t('printSales.choosePrintOptions', 'Choose print options')} ({picked.length})</Button>
  </> : view === 'editor' ? <>
    <Button variant="secondary" onClick={() => editing ? setView('basket') : chooseMore()}>{t('common.back', 'Back')}</Button>
    <Button disabled={!validDraft || !previewReady || drafts.some(d => !d.ready) || (!editing && cart.length + drafts.length > MAX_ITEMS)} onClick={add}>
      {editing ? t('printSales.saveCrop', 'Update basket item') : t('printSales.addToBasket', 'Add to basket')}{!editing && drafts.length > 1 ? ` (${drafts.length})` : ''}
    </Button>
  </> : quoteId ? <>
    <Button disabled={busy} variant="secondary" onClick={() => void discard()}>{t('printSales.editBasket', 'Return to basket')}</Button>
    <Button disabled={busy || !approved || !ready} onClick={accept}>{t('printSales.confirmInvoice', 'Confirm order and request invoice')}</Button>
  </> : <Button disabled={busy || !!quoteId || !cart.length || invalidLines.size > 0 || stale} onClick={prepare}>{t('printSales.reviewOrder', 'Review selections and final total')}</Button>;
  return <PrintSalesContext.Provider value={{ available, hasOrders: orders.some(o => !!o.acceptedAt), count: cart.length, openPhoto: id => start(id), openBulk: () => start(), openBasket: () => { setError(''); setView('basket'); } }}>
    {children}
    {!!error && !view && <p role="alert" className="max-w-7xl mx-auto px-4">{error}</p>}
    <Modal open={!!view} onClose={() => { if (!busy) setView(undefined); }} size="xl" className="print-shop-dialog" footer={<>
      {!!estimateLabel && view !== 'photos' && !quoteId && <p className="print-estimate">{estimateLabel} <span className="text-xs text-muted">{t('printSales.estimateBeforeTax', 'before tax and delivery')}</span></p>}{footer}
    </>}
      title={view === 'photos' ? t('printSales.choosePhotos', 'Choose photographs to print') : view === 'editor' ? t('printSales.quickPrint', 'Make it a print') : quoteId ? t('printSales.orderReview', 'Review print order') : t('printSales.basket', 'Your prints & orders')}
      description={view === 'editor' ? t('printSales.cropEach', 'Choose a size and check the crop of each photograph.') : t('printSales.invoiceJourney', 'Confirm your selections here. The studio will send an invoice and check the prepared files before ordering from the lab.')}>
      <fieldset disabled={busy} className="min-w-0 space-y-5">
        {view === 'photos' && <PhotoPicker photos={photographs} slug={slug} selected={picked} limit={MAX_ITEMS - cart.length} onToggle={id => setPicked(ids => ids.includes(id) ? ids.filter(p => p !== id) : ids.length < MAX_ITEMS - cart.length ? [...ids, id] : ids)} />}
        {view === 'editor' && offers && <>
          <PrintEditor slug={slug} photos={photographs} variants={offers.variants} drafts={drafts} active={active} setActive={n => { setActive(n); setPreviewReady(false); }}
            update={updateDraft} onValidity={setValidDraft} onPreviewReady={setPreviewReady} editing={!!editing} chooseMore={chooseMore} applyAll={() => {
              if (!validDraft) return;
              const source = drafts[active], v = offers.variants.find(v => v.id === source.profileId)!;
              setDrafts(rows => rows.map((d, n) => n === active ? d : newDraft(d.photoId, v, source)));
            }} />
          {!editing && cart.length + drafts.length > MAX_ITEMS && <p role="alert">{t('printSales.basketLimit', 'Your basket has reached the 20 photo item limit. Remove an item before adding another.')}</p>}
          {drafts.some(d => !d.ready) && <p className="text-sm text-muted" role="status">{t('printSales.reviewEveryPhoto', 'Open each selected photograph to check its crop before adding the prints.')}</p>}
        </>}
        {view === 'basket' && !quoteId && <>
          {!cart.length && <p>{t('printSales.emptyBasket', 'Your basket is empty. Start with a favourite photograph.')}</p>}
          <button type="button" className="print-text-button" disabled={!available || cart.length >= MAX_ITEMS} onClick={() => start()}>{t('printSales.addPhotographs', 'Add photographs')}</button>
          {cart.map(item => {
            const p = photographs.find(p => p.id === item.photoId), v = offers?.variants.find(v => v.id === item.profileId);
            return <article key={item.lineId} className="print-basket-line">
              {p && v && <CropPreview src={photoSource(p)} slug={slug} crop={item.crop} fit={item.fit} background={v.background} ratio={v.artwork.widthMm / v.artwork.heightMm} />}
              <div className="min-w-0 flex-1"><h3 className="font-semibold break-words">{p ? photoName(p) : `#${item.photoId}`}</h3>
                <p>{v?.selection.product.name} · {v && dimensions(v)}</p><p className="text-sm text-muted">{v && choices(v)}</p>
                {v && <p className="text-sm">{formatMoneyMinor(v.unitPriceMinor, v.currency)} · {t('printSales.perCopyBeforeTax', 'per copy, before tax')}</p>}
                <div className="flex gap-4 mt-2"><button type="button" className="print-text-button" disabled={!p || !v} onClick={() => edit(item)}>{t('printSales.editCrop', 'Edit crop')}</button>
                  <button type="button" className="print-text-button" onClick={() => { changeCart(cart.filter(i => i.lineId !== item.lineId)); setInvalidLines(ids => { const next = new Set(ids); next.delete(item.lineId); return next; }); }}>{t('common.remove', 'Remove')}</button></div>
              </div>
              <QuantityControl value={item.quantity} label={`${t('printSales.quantity', 'Copies')}: ${p ? photoName(p) : item.photoId}`} onChange={quantity => changeCart(cart.map(i => i.lineId === item.lineId ? { ...i, quantity } : i))}
                onValidity={valid => setInvalidLines(ids => { if (valid === !ids.has(item.lineId)) return ids; const next = new Set(ids); if (valid) next.delete(item.lineId); else next.add(item.lineId); return next; })} />
            </article>;
          })}
          {stale && <p role="alert">{t('printSales.changedBasket', 'A photograph or product has changed. Edit the affected items to review the current options, or remove them before continuing.')}</p>}
          {!!cart.length && <section className="space-y-3"><h3 className="font-semibold">{t('printSales.deliveryAddress', 'Delivery address')}</h3>
            <div className="grid gap-3 sm:grid-cols-2">{(Object.keys(addressLabels) as (keyof typeof addressLabels)[]).map(key => <label key={key}>{t(`printSales.address.${key}`, addressLabels[key])}
              <input className="input w-full" value={delivery[key]} maxLength={200} autoComplete={{ name: 'name', line1: 'address-line1', line2: 'address-line2', city: 'address-level2', region: 'address-level1', postalCode: 'postal-code' }[key]}
                onChange={e => { setDelivery({ ...delivery, [key]: e.target.value }); invalidate(); }} /></label>)}</div>
            <label className="block">{t('printSales.country', 'Country')}<select className="input w-full" value={delivery.country} onChange={e => { setDelivery({ ...delivery, country: e.target.value }); invalidate(); }}>
              {offers?.countries.map(c => <option key={c} value={c}>{c}</option>)}</select></label>
          </section>}
          {orders.filter(o => o.acceptedAt).map(o => <article className="border border-border-token rounded-lg p-4" key={o.id}>
            <h3>{o.status === 'cancelled' ? t('printSales.orderCancelled', 'Order cancelled') : o.status === 'resolved' ? t('printSales.closedManually', 'Closed manually') : t('printSales.orderConfirmed', 'Order confirmed')} · {o.id.slice(0, 8)}</h3>
            <p>{formatMoneyMinor(o.totalMinor, o.currency)} · {t('printSales.invoiceNumber', 'Invoice')} #{o.invoiceId}</p>
            <p>{o.status === 'resolved' ? t('printSales.closedManuallyHelp', 'The studio closed this order. Please contact them with any questions.') : o.dispatchedAt ? t('printSales.dispatched', 'Dispatched') : o.submittedAt ? t('printSales.withLab', 'Submitted to the lab') : t('printSales.studioReview', 'The studio is arranging your invoice and checking the artwork.')}</p>
            {o.tracking && <p>{o.tracking}</p>}
          </article>)}
        </>}
        {view === 'basket' && quoteId && <>
          <PreparationProgress value={expired && quote ? { ...quote.preparation, stage: 'expired' } : quote?.preparation} failedToLoad={preparation.isError} retry={() => void preparation.refetch()} />
          {quote?.status === 'quoted' && <p className="text-sm text-muted">{t('printSales.reviewDeadline', 'Confirm by')}: <time dateTime={quote.expiresAt}>{formatDateTime(quote.expiresAt)}</time></p>}
          {quote && !quote.acceptedAt && ['capturing', 'failed'].includes(quote.status) && <p className="text-sm text-muted">{t('printSales.noInvoiceYet', 'No invoice has been created. You can close this window while we prepare your files.')}</p>}
        </>}
        {view === 'basket' && quote && <section className="space-y-4" aria-label={t('printSales.orderReview', 'Review print order')}>
          <ul>{quote.items?.map((i, n) => { const p = photographs.find(p => p.id === i.photoId); return <li key={n} className="print-basket-line">
            {p && <CropPreview src={photoSource(p)} slug={slug} crop={i.crop} fit={i.fit} background={i.background} ratio={(i.artwork?.widthMm || 2) / (i.artwork?.heightMm || 3)} />}
            <div>{i.filename} · <ChoiceSummary choice={i.selection} /> × {i.quantity}</div></li>; })}</ul>
          <p>{t('printSales.net', 'Before tax')}: {formatMoneyMinor(quote.netMinor, quote.currency)} · {t('printSales.tax', 'Tax')}: {formatMoneyMinor(quote.vatMinor, quote.currency)}</p>
          <p className="text-lg font-semibold">{t('printSales.finalTotal', 'Total including delivery and tax')}: {formatMoneyMinor(quote.totalMinor, quote.currency)}</p>
          <p>{quote.delivery && Object.values(quote.delivery).filter(Boolean).join(', ')}</p><p className="whitespace-pre-wrap">{quote.policy}</p>
          <label className="flex gap-3"><input type="checkbox" disabled={!ready} checked={approved} onChange={e => setApproved(e.target.checked)} />{t('printSales.selectionConsent', 'I confirm these photographs, crops, quantities, prices, delivery details and the buyer policy.')}</label>
        </section>}
        {error && <div role="alert" className="space-y-2"><p>{error}</p><button type="button" className="print-text-button" onClick={() => void loadOffers()}>{t('printSales.refreshChoices', 'Refresh available print options')}</button></div>}
      </fieldset>
    </Modal>
  </PrintSalesContext.Provider>;
}
export function PrintShopEntry() {
  const shop = usePrintSales(), { t } = useTranslation();
  if (!shop?.available && !shop?.hasOrders) return null;
  return <section className="print-shop-entry max-w-7xl mx-auto px-4 py-6">
    <div><h2 className="text-lg font-semibold">{t('printSales.shop', 'Order photographic prints')}</h2><p className="text-sm text-muted">{t('printSales.entryHint', 'Your favourites, ready for a desk or a wall. Choose a photograph to get started.')}</p></div>
    <div className="flex flex-wrap gap-3"><Button disabled={!shop.available} onClick={shop.openBulk}>{t('printSales.choosePrints', 'Choose prints')}</Button><Button variant="secondary" onClick={shop.openBasket}>{t('printSales.basketShort', 'Prints & orders')} ({shop.count})</Button></div>
  </section>;
}
export function GalleryPrintShop({ slug, photos }: { slug: string; photos: Photo[] }) {
  return <PrintSalesProvider slug={slug} photos={photos}><PrintShopEntry /></PrintSalesProvider>;
}
