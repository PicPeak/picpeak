import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { api } from '../../config/api';
import { Button, Loading } from '../../components/common';
import { SettingsSaveBar } from '../../components/admin/SettingsSaveBar';
import { usePermissions } from '../../contexts/PermissionsContext';
import { useFeatureEnabled } from '../../contexts/FeatureFlagsContext';
import { errorMessage } from '../album-products/model';
import { formatMoneyMinor } from '../../utils/money';
import { ProfileEditor } from './ProfileEditor';
import { printSales, type Settings, type Order, type Profile } from './model';
function newProfile(): Profile {
  return { cataloguePresetId: 0, definition: { id: crypto.randomUUID(), revision: 1, enabled: false, labReference: '',
    selection: { productId: '', productVersion: '', values: {} }, manufacturing: { capability: 'single-photo-rectangle',
      trimMm: { width: 100, height: 150 }, bleedMm: { top: 0, right: 0, bottom: 0, left: 0 },
      safeInsetMm: { top: 0, right: 0, bottom: 0, left: 0 }, resolution: { targetDpi: 300, minimumDpi: 150 },
      output: { format: 'jpeg', colourSpace: 'srgb' }, fitModes: ['cover', 'contain'] } } };
}
function StudioOrder({ initial, onError }: { initial: Order; onError: (s: string) => void }) {
  const { hasPermission } = usePermissions();
  const canManage = ['products.configure', 'bills.manage', 'customers.edit'].every(hasPermission);
  const { t } = useTranslation(), [order, setOrder] = useState(initial), [busy, setBusy] = useState(false),
    [reference, setReference] = useState(initial.supplierReference || ''), [tracking, setTracking] = useState(initial.tracking || '');
  const act = async (action: string) => {
    setBusy(true); onError('');
    try { setOrder(await printSales.action(order.id, action, { artworkVersion: order.artworkVersion, supplierReference: reference, tracking })); }
    catch (e) { onError(errorMessage(e)); } finally { setBusy(false); }
  };
  const download = async (kind: string) => {
    setBusy(true); onError('');
    try {
      const r = await api.get(`/admin/print-sales/orders/${order.id}/files/${kind}`, { responseType: 'blob' });
      const url = URL.createObjectURL(r.data), a = document.createElement('a');
      a.href = url; a.download = `print-${order.id}.${kind === 'pack' ? 'zip' : 'pdf'}`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) { onError(errorMessage(e)); } finally { setBusy(false); }
  };
  return <details className="border border-line rounded-lg p-4 space-y-3"><summary className="cursor-pointer">
    {order.id.slice(0, 8)} · {order.items?.length || 0} {t('printSales.photos', 'photo items')} · {order.currency && formatMoneyMinor(order.totalMinor, order.currency)}
    {' · '}{order.status} / {order.renderStatus}</summary>
    {order.invoiceId && <Link className="underline" to={`/admin/clients/bills/${order.invoiceId}`}>{t('printSales.openInvoice', 'Open native invoice')} #{order.invoiceId}</Link>}
    <p>{order.buyerEmail} · {order.delivery && Object.values(order.delivery).filter(Boolean).join(', ')}</p>
    <ul>{order.items?.map((i, n) => <li key={n}>{i.filename} — {i.selection.product.name} × {i.quantity}</li>)}</ul>
    {order.needsAttention && <p role="status" className="text-warning-text">{t('printSales.needsAttention', 'This order needs studio attention. Payment and file preparation are checked separately.')}</p>}
    <fieldset disabled={busy || !canManage} className="flex flex-wrap gap-3">
      {order.renderStatus === 'ready' && !order.purgedAt && <>
        <Button variant="secondary" onClick={() => download('pack')}>{t('printSales.supplierPack', 'Supplier pack')}</Button>
        <Button variant="secondary" onClick={() => download('sheet')}>{t('printSales.orderSheet', 'Studio order sheet')}</Button>
        {!order.submittedAt && <Button variant="secondary" onClick={() => act('review')}>{t('printSales.recordReview', 'I checked these production files')}</Button>}
        {order.reviewedAt && !order.submittedAt && <label>{t('printSales.externalReference', 'Lab order reference')}
          <input className="input" value={reference} onChange={e => setReference(e.target.value)} maxLength={200} />
          <Button disabled={!reference.trim()} onClick={() => act('submit')}>{t('printSales.recordSubmission', 'Record manual lab submission')}</Button></label>}
        {order.submittedAt && !order.dispatchedAt && <label>{t('printSales.tracking', 'Tracking / dispatch note')}
          <input className="input" value={tracking} onChange={e => setTracking(e.target.value)} maxLength={500} />
          <Button onClick={() => act('dispatch')}>{t('printSales.recordDispatch', 'Record dispatch')}</Button></label>}
      </>}
      {order.renderStatus === 'failed' && order.acceptedAt && <Button variant="secondary" onClick={() => act('retry')}>{t('printSales.retryPreparation', 'Retry artwork preparation')}</Button>}
      {!order.submittedAt && order.status !== 'cancelled' && <Button variant="secondary" onClick={() => act('cancel')}>{t('printSales.cancelAfterInvoice', 'Cancel order after native invoice correction')}</Button>}
    </fieldset>
    {order.supplierReference && <p>{t('printSales.labReference', 'Lab reference or production code')}: {order.supplierReference}</p>}
    {order.dispatchedAt && <p>{t('printSales.dispatched', 'Dispatched')}: {order.dispatchedAt} {order.tracking}</p>}
  </details>;
}
export function PrintSalesAdminPage() {
  const { t } = useTranslation(), { hasPermission } = usePermissions(), enabled = useFeatureEnabled('printSales');
  const canConfigure = enabled && hasPermission('products.manage') && hasPermission('bills.manage'),
    canOrders = hasPermission('bills.view') && hasPermission('customers.view');
  const [saved, setSaved] = useState<Settings>(), [draft, setDraft] = useState<Settings>(),
    [orders, setOrders] = useState<Order[]>([]), [error, setError] = useState(''), [busy, setBusy] = useState(false), [offset, setOffset] = useState(0);
  useEffect(() => { let active = true; printSales.settings().then(s => { if (active) { setSaved(s); setDraft(s); } }).catch(e => { if (active) setError(errorMessage(e)); }); return () => { active = false; }; }, []);
  useEffect(() => { let active = true; if (canOrders) printSales.orders(offset).then(rows => { if (active) setOrders(rows); }).catch(e => { if (active) setError(errorMessage(e)); }); return () => { active = false; }; }, [canOrders, offset]);
  const save = async () => {
    if (!draft) return; setBusy(true); setError('');
    try { const result = { ...draft, ...await printSales.save(draft) }; setSaved(result); setDraft(result); }
    catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  };
  return <div className="space-y-6">
    <p className="text-muted">{t('printSales.help', 'Configure production requirements for shared catalogue products. Prices, tax and payments use native CRM invoices; lab submission is manual.')}</p>
    {!enabled && <p>{t('printSales.closed', 'Print ordering is disabled. Existing orders remain available for review.')}</p>}
    {!draft && !error && <Loading />}
    {draft && <fieldset disabled={!canConfigure || busy} className="space-y-5">
      <label className="block">{t('printSales.countries', 'Delivery countries (two-letter codes, separated by commas)')}
        <input className="input w-full" value={draft.countries.join(', ')} onChange={e => setDraft({ ...draft, countries: e.target.value.toUpperCase().split(',').map(s => s.trim()) })} /></label>
      <label className="block">{t('printSales.deliveryPrice', 'Delivery price from CRM catalogue')}
        <select className="input w-full" value={draft.shippingPresetId ?? ''} onChange={e => setDraft({ ...draft, shippingPresetId: e.target.value ? Number(e.target.value) : null })}>
          <option value="">{t('printSales.includedDelivery', 'Delivery included (no extra line)')}</option>
          {draft.presets?.filter(p => !p.product_id).map(p => <option key={p.id} value={p.id}>{p.name} ({p.currency})</option>)}
        </select></label>
      <label className="block">{t('printSales.policy', 'Buyer policy and delivery information')}
        <textarea className="input w-full" rows={4} maxLength={5000} value={draft.policy} onChange={e => setDraft({ ...draft, policy: e.target.value })} /></label>
      {draft.profiles.map((p, n) => <div key={p.definition.id} className="space-y-2">
        <ProfileEditor value={p} products={draft.products || []} presets={draft.presets} onChange={value => setDraft({ ...draft, profiles: draft.profiles.map((p, i) => i === n ? value : p) })} />
        <Button variant="ghost" onClick={() => setDraft({ ...draft, profiles: draft.profiles.filter((_, i) => i !== n) })}>{t('printSales.removeProfile', 'Remove variant from future orders')}</Button>
      </div>)}
      <Button variant="secondary" disabled={draft.profiles.length >= 100} onClick={() => setDraft({ ...draft, profiles: [...draft.profiles, newProfile()] })}>{t('printSales.addProfile', 'Add print variant')}</Button>
    </fieldset>}
    {canOrders && <section className="space-y-3"><h2 className="text-lg font-semibold">{t('printSales.orders', 'Print orders')}</h2>
      <Button variant="secondary" onClick={() => printSales.orders(offset).then(setOrders).catch(e => setError(errorMessage(e)))}>{t('common.refresh', 'Refresh')}</Button>
      {orders.map(o => <StudioOrder key={`${o.id}-${o.renderStatus}-${o.status}`} initial={o} onError={setError} />)}
      <div className="flex gap-3"><Button variant="secondary" disabled={!offset} onClick={() => setOffset(n => Math.max(0, n - 50))}>{t('common.previous', 'Previous')}</Button>
        <Button variant="secondary" disabled={orders.length < 50} onClick={() => setOffset(n => n + 50)}>{t('common.next', 'Next')}</Button></div>
    </section>}
    {error && <p role="alert" className="text-danger-text">{error}</p>}
    {canConfigure && <SettingsSaveBar isDirty={JSON.stringify(saved) !== JSON.stringify(draft)} isSaving={busy}
      onSave={save} onDiscard={() => setDraft(saved)} canSave={!!draft} />}
  </div>;
}
