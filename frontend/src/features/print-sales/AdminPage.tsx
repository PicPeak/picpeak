import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { api } from '../../config/api';
import { Button, Loading, EmptyState, ErrorState, Notice, Badge } from '../../components/common';
import { SettingsSaveBar } from '../../components/admin/SettingsSaveBar';
import { usePermissions } from '../../contexts/PermissionsContext';
import { useFeatureEnabled } from '../../contexts/FeatureFlagsContext';
import { errorMessage } from '../album-products/model';
import { formatMoneyMinor } from '../../utils/money';
import { ProfileEditor } from './ProfileEditor';
import { DeliveryEditor } from './DeliveryEditor';
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
  const canFiles = ['products.configure', 'bills.manage', 'customers.view'].every(hasPermission);
  const canManage = ['products.configure', 'bills.manage', 'customers.edit'].every(hasPermission);
  const { t } = useTranslation(), [order, setOrder] = useState(initial), [busy, setBusy] = useState(false),
    [reference, setReference] = useState(initial.supplierReference || ''), [tracking, setTracking] = useState(initial.tracking || '');
  useEffect(() => { setOrder(initial); }, [initial]);
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
    <span className="inline-flex gap-2 ml-2"><Badge tone={order.status === 'cancelled' ? 'storno' : order.status === 'dispatched' ? 'success' : 'neutral'}>
      {({ capturing: t('printSales.statusCapturing', 'Preparing quotation'), quoted: t('printSales.statusQuoted', 'Awaiting confirmation'),
        accepted: t('printSales.orderConfirmed', 'Order confirmed'), dispatched: t('printSales.dispatched', 'Dispatched'),
        failed: t('printSales.statusFailed', 'Quotation failed'), expired: t('printSales.statusExpired', 'Expired'), cancelled: t('printSales.orderCancelled', 'Order cancelled') } as Record<string, string>)[order.status] || t('printSales.unknownStatus', 'Unknown status')}
    </Badge><Badge tone={order.renderStatus === 'failed' ? 'danger' : order.renderStatus === 'ready' ? 'success' : 'info'}>
      {({ pending: t('printSales.artworkPending', 'Artwork not queued'), queued: t('printSales.artworkQueued', 'Artwork queued'),
        running: t('printSales.artworkRunning', 'Preparing artwork'), ready: t('printSales.artworkReady', 'Artwork ready'),
        failed: t('printSales.artworkFailed', 'Artwork preparation failed'), cancelled: t('printSales.artworkStopped', 'Artwork preparation stopped') } as Record<string, string>)[order.renderStatus] || t('printSales.unknownStatus', 'Unknown status')}
    </Badge></span></summary>
    {order.invoiceId && <Link className="underline" to={`/admin/clients/bills/${order.invoiceId}`}>{t('printSales.openInvoice', 'Open native invoice')} #{order.invoiceId}</Link>}
    <p>{order.buyerEmail} · {order.delivery && Object.values(order.delivery).filter(Boolean).join(', ')}</p>
    <ul>{order.items?.map((i, n) => <li key={n}>{i.filename} — {i.selection.product.name} × {i.quantity}</li>)}</ul>
    {order.needsAttention && <p role="status" className="text-warning-text">{t('printSales.needsAttention', 'This order needs studio attention. Payment and file preparation are checked separately.')}</p>}
    <fieldset disabled={busy} className="min-w-0 flex flex-wrap gap-3">
      {order.renderStatus === 'ready' && !order.purgedAt && <>
        {canFiles && <Button variant="secondary" onClick={() => download('pack')}>{t('printSales.supplierPack', 'Supplier pack')}</Button>}
        {canFiles && <Button variant="secondary" onClick={() => download('sheet')}>{t('printSales.orderSheet', 'Studio order sheet')}</Button>}
        {canManage && !order.submittedAt && <Button variant="secondary" onClick={() => act('review')}>{t('printSales.recordReview', 'I checked these production files')}</Button>}
        {canManage && order.reviewedAt && !order.submittedAt && <label>{t('printSales.externalReference', 'Lab order reference')}
          <input className="input" value={reference} onChange={e => setReference(e.target.value)} maxLength={200} />
          <Button disabled={!reference.trim()} onClick={() => act('submit')}>{t('printSales.recordSubmission', 'Record manual lab submission')}</Button></label>}
        {canManage && order.submittedAt && !order.dispatchedAt && <label>{t('printSales.tracking', 'Tracking / dispatch note')}
          <input className="input" value={tracking} onChange={e => setTracking(e.target.value)} maxLength={500} />
          <Button onClick={() => act('dispatch')}>{t('printSales.recordDispatch', 'Record dispatch')}</Button></label>}
      </>}
      {canManage && order.renderStatus === 'failed' && order.acceptedAt && <Button variant="secondary" onClick={() => act('retry')}>{t('printSales.retryPreparation', 'Retry artwork preparation')}</Button>}
      {canManage && !order.submittedAt && order.status !== 'cancelled' && <Button variant="secondary" onClick={() => act('cancel')}>{t('printSales.cancelAfterInvoice', 'Cancel order after native invoice correction')}</Button>}
    </fieldset>
    {order.supplierReference && <p>{t('printSales.labReference', 'Lab reference or production code')}: {order.supplierReference}</p>}
    {order.dispatchedAt && <p>{t('printSales.dispatched', 'Dispatched')}: {order.dispatchedAt} {order.tracking}</p>}
  </details>;
}
export function PrintSalesAdminPage() {
  const { t } = useTranslation(), { hasPermission } = usePermissions(), enabled = useFeatureEnabled('printSales');
  const canSettings = hasPermission('products.view');
  const canConfigure = enabled && hasPermission('products.manage') && hasPermission('bills.manage'),
    canOrders = canSettings && hasPermission('bills.view') && hasPermission('customers.view');
  const client = useQueryClient();
  const [saved, setSaved] = useState<Settings>(), [draft, setDraft] = useState<Settings>(),
    [error, setError] = useState(''), [busy, setBusy] = useState(false), [offset, setOffset] = useState(0);
  const settings = useQuery({ queryKey: ['print-sales', 'settings'], queryFn: printSales.settings, enabled: canSettings, refetchOnWindowFocus: false });
  const orders = useQuery({ queryKey: ['print-sales', 'orders', offset], queryFn: () => printSales.orders(offset), enabled: canOrders,
    refetchInterval: query => enabled && query.state.data?.some(o => ['queued', 'running'].includes(o.renderStatus)) ? 10000 : false });
  const isDirty = JSON.stringify(saved) !== JSON.stringify(draft);
  useEffect(() => {
    // Refresh clean settings, but retain an edited draft and its optimistic revision after a refetch.
    if (settings.data && !isDirty) { setSaved(settings.data); setDraft(settings.data); }
  }, [settings.data, isDirty]);
  const save = async () => {
    if (!draft) return; setBusy(true); setError('');
    try { const result = { ...draft, ...await printSales.save(draft) }; setSaved(result); setDraft(result); client.setQueryData(['print-sales', 'settings'], result); }
    catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  };
  return <div className="space-y-6 [&_button]:max-w-full [&_button]:whitespace-normal">
    <p className="text-muted">{t('printSales.help', 'Configure production requirements for shared catalogue products. Prices, tax and payments use native CRM invoices; lab submission is manual.')}</p>
    {!enabled && <Notice>{t('printSales.closed', 'Print ordering is disabled. Existing orders remain available for review.')}</Notice>}
    {enabled && canSettings && !canConfigure && <Notice>{t('printSales.readOnly', 'You can view these print settings but cannot change them.')}</Notice>}
    {canSettings && settings.isPending && <Loading />}
    {settings.isError && <ErrorState size="inline" title={t('printSales.settingsFailed', 'Could not load print settings')} message={errorMessage(settings.error)} onRetry={() => { void settings.refetch(); }} retrying={settings.isFetching} />}
    {canSettings && draft && <fieldset disabled={!canConfigure || busy} className="min-w-0 space-y-5">
      <DeliveryEditor value={draft} onChange={setDraft} />
      <label className="block">{t('printSales.policy', 'Buyer policy and delivery information')}
        <textarea className="input w-full" rows={4} maxLength={5000} value={draft.policy} onChange={e => setDraft({ ...draft, policy: e.target.value })} /></label>
      {draft.profiles.map((p, n) => <div key={p.definition.id} className="space-y-2">
        <ProfileEditor value={p} products={draft.products || []} presets={draft.presets} onChange={value => setDraft({ ...draft, profiles: draft.profiles.map((p, i) => i === n ? value : p) })} />
        <Button variant="ghost" onClick={() => setDraft({ ...draft, profiles: draft.profiles.filter((_, i) => i !== n) })}>{t('printSales.removeProfile', 'Remove variant from future orders')}</Button>
      </div>)}
      <Button variant="secondary" disabled={draft.profiles.length >= 100} onClick={() => setDraft({ ...draft, profiles: [...draft.profiles, newProfile()] })}>{t('printSales.addProfile', 'Add print variant')}</Button>
    </fieldset>}
    {canOrders && <section className="space-y-3"><h2 className="text-lg font-semibold">{t('printSales.orders', 'Print orders')}</h2>
      <Button variant="secondary" isLoading={orders.isFetching} onClick={() => { void orders.refetch(); }}>{t('printSales.refresh', 'Refresh')}</Button>
      {orders.isPending && <Loading />}
      {orders.isError && <ErrorState size="inline" title={t('printSales.ordersFailed', 'Could not load print orders')} message={errorMessage(orders.error)} onRetry={() => { void orders.refetch(); }} retrying={orders.isFetching} />}
      {orders.isSuccess && !orders.data.length && <EmptyState size="inline" title={t('printSales.noOrders', 'No print orders yet')} description={t('printSales.noOrdersHelp', 'Enable ordering for an assigned customer’s gallery to receive an order.')} />}
      {orders.data?.map(o => <StudioOrder key={o.id} initial={o} onError={setError} />)}
      <div className="flex gap-3"><Button variant="secondary" disabled={!offset || orders.isFetching} onClick={() => setOffset(n => Math.max(0, n - 50))}>{t('common.previous', 'Previous')}</Button>
        <Button variant="secondary" disabled={!orders.isSuccess || orders.data.length < 50 || orders.isFetching} onClick={() => setOffset(n => n + 50)}>{t('common.next', 'Next')}</Button></div>
    </section>}
    {error && <p role="alert" className="text-danger-text">{error}</p>}
    {canConfigure && <SettingsSaveBar isDirty={isDirty} isSaving={busy}
      onSave={save} onDiscard={() => setDraft(saved)} canSave={!!draft} />}
  </div>;
}
