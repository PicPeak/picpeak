import { PrintGallerySettings } from '../print-sales/GallerySettings';
import { useQuery } from '@tanstack/react-query';
import { ChoiceSummary } from './ConfigurationPicker';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { toast } from 'react-toastify';
import { Button, Card, Badge, Loading, Notice, useConfirm } from '../../components/common';
import { AdminAuthenticatedImage } from '../../components/admin/AdminAuthenticatedImage';
import { useLocalizedDate } from '../../hooks/useLocalizedDate';
import { useFeatureEnabled } from '../../contexts/FeatureFlagsContext';
import { usePermissions } from '../../contexts/PermissionsContext';
import { AlbumChoiceDetails } from './AlbumChoiceDetails';
import { albumProducts, errorMessage, type ChosenPhoto, type Offer } from './model';
import { api } from '../../config/api';
import { formatMoneyMinor } from '../../utils/money';
const statusLabel = (
  t: ReturnType<typeof useTranslation>['t'],
  status: Offer['status'],
  clientFinal?: boolean,
) =>
  status === 'locked'
    ? t('albumProducts.locked', 'Locked by the studio')
    : status === 'submitted'
      ? clientFinal
        ? t('albumProducts.confirmedByClient', 'Confirmed by the client')
        : t('albumProducts.submitted', 'Submitted')
      : t('albumProducts.draft', 'Draft');
function AdminAlbumPhoto({ eventId, photo }: { eventId: number; photo: ChosenPhoto }) {
  const { t } = useTranslation();
  return (
    <>
      <span className="block aspect-square overflow-hidden rounded-lg bg-inset">
        <AdminAuthenticatedImage
          src={`/admin/photos/${eventId}/thumbnail/${photo.id}`}
          alt={photo.filename || ''}
          className="h-full w-full object-cover"
          loading="lazy"
        />
      </span>
      <span className="mt-1 block break-all text-xs text-muted">{photo.filename}</span>
      {photo.originalFilename && photo.originalFilename !== photo.filename && (
        <span className="block break-all text-xs text-muted">{photo.originalFilename}</span>
      )}
      {photo.available === false && (
        <Badge tone="warning">{t('albumProducts.photoGone', 'No longer available')}</Badge>
      )}
    </>
  );
}
/** Who changed the choice and when, read when the studio opens it. */
function OfferHistory({ eventId, offer }: { eventId: number; offer: Offer }) {
  const { t } = useTranslation(),
    { formatDateTime } = useLocalizedDate();
  const [open, setOpen] = useState(false);
  const history = useQuery({
    queryKey: ['gallery-product-history', eventId, offer.id, offer.revision],
    queryFn: () => albumProducts.history(eventId, offer.id),
    enabled: open,
  });
  return (
    <details onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="cursor-pointer text-sm text-body">
        {t('albumProducts.history', 'Choice history')}
      </summary>
      <ol className="mt-2 space-y-1 text-sm text-muted">
        {history.data?.map((entry) => (
          <li key={entry.id}>
            {formatDateTime(entry.created_at)} · {statusLabel(t, entry.status)} ·{' '}
            {entry.actor_name ||
              (entry.actor_type === 'admin'
                ? t('albumProducts.actorStudio', 'Studio')
                : t('albumProducts.actorClient', 'Client'))}
          </li>
        ))}
      </ol>
      {history.isError && (
        <p role="alert" className="text-sm text-danger-text">
          {errorMessage(history.error)}
        </p>
      )}
    </details>
  );
}
function EventProducts({ eventId, ownsEvent, slug }: { eventId: number; ownsEvent: boolean; slug?: string }) {
  const { t } = useTranslation(),
    { hasPermission } = usePermissions(),
    confirm = useConfirm();
  const [selected, setSelected] = useState(''),
    [audience, setAudience] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const query = useQuery({
    queryKey: ['gallery-products', eventId],
    queryFn: () => albumProducts.event(eventId),
  });
  const catalogue = query.data?.catalogue,
    offers = query.data?.offers || [],
    customers = query.data?.customers || [];
  const billingEnabled = useFeatureEnabled('bills');
  const crmEnabled = billingEnabled && ownsEvent && hasPermission('bills.manage');
  const canConfirm = ownsEvent && (!billingEnabled || hasPermission('bills.manage'));
  const billing = useQuery({
    queryKey: ['gallery-product-billing', eventId],
    enabled: crmEnabled,
    queryFn: () =>
      api
        .get<{
          items: {
            id: number;
            offer_id: string;
            customer_account_id: number;
            invoice_id: number | null;
            currency: string;
            line_item: string;
          }[];
          presets: {
            id: number;
            name: string;
            product_id: string;
            currency: string;
          }[];
          customers: { id: number; display_name: string; email: string }[];
        }>(`/admin/album-products/events/${eventId}/billing`)
        .then((r) => r.data),
    retry: false,
  });
  const priceSetting = async (
    offer: Offer,
    update: {
      cataloguePresetId?: number | null;
      showPrices?: boolean;
      customerId?: number | null;
    },
  ) => {
    setBusy(true);
    setError('');
    try {
      await albumProducts.update(eventId, offer, update);
      await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const bill = async (customerId: number) => {
    setBusy(true);
    setError('');
    try {
      await api.post(`/admin/album-products/events/${eventId}/billing`, {
        customerId,
      });
      await billing.refetch();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const load = async () => {
    await query.refetch();
    if (crmEnabled) await billing.refetch();
  };
  const changeAudience = async (offer: Offer, value: string) => {
    setBusy(true);
    setError('');
    try {
      await albumProducts.update(eventId, offer, {
        releasedCustomerId: value ? Number(value) : null,
      });
      await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  // A customer's way in; the gallery client already has the client access link.
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(
        `${window.location.origin}/customer/events/${slug}`,
      );
      toast.success(t('albumProducts.linkCopied', 'Client link copied'));
    } catch {
      toast.error(t('albumProducts.linkCopyFailed', 'The link could not be copied'));
    }
  };
  const reopen = async (offer: Offer) => {
    const ok = await confirm({
      title: t('albumProducts.reopenTitle', 'Reopen this selection?'),
      message: t(
        'albumProducts.reopenMessage',
        'The client can change the confirmed selection again, and has to confirm it again. The reopening is recorded in the activity log.',
      ),
      confirmLabel: t('albumProducts.reopen', 'Reopen for the client'),
      variant: 'warning',
    });
    if (ok) await change(offer, 'reopen');
  };
  const change = async (offer: Offer, action: 'lock' | 'unlock' | 'reopen' | 'toggle') => {
    setBusy(true);
    setError('');
    try {
      await albumProducts.update(
        eventId,
        offer,
        action === 'toggle' ? { enabled: !offer.enabled } : { action },
      );
      await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const assign = async () => {
    setBusy(true);
    setError('');
    try {
      await albumProducts.assign(eventId, selected, audience ? Number(audience) : undefined);
      await load();
      setSelected('');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  if (query.isLoading) return <Loading />;
  return (
    <Card className="p-6 space-y-4">
      <h3 className="text-lg font-semibold">
        {t('albumProducts.galleryTitle', 'Product configuration')}
      </h3>
      <p className="text-sm text-muted">
        {t(
          'albumProducts.galleryHelp',
          'Offer a product to the gallery’s client. Guests cannot change the configuration. Lock a submitted choice when it is confirmed.',
        )}
      </p>
      {crmEnabled && (
        <p className="text-sm text-muted">
          {t(
            'products.lockBillingHelp',
            'Locking freezes the current CRM price and creates a billable item. An eligible unissued project invoice receives a separate product line.',
          )}
        </p>
      )}
      {offers.map((offer) => {
        const guided = !!catalogue?.products.find((p) => p.id === offer.productId)?.guided
          || !!offer.selection?.photoRoles;
        const clientFinal = !!offer.selection?.clientFinal
          && (offer.status === 'submitted' || offer.status === 'locked');
        const audienceCustomer = customers.find((c) => c.id === offer.releasedCustomerId);
        return (
        <div
          className="rounded-lg border border-line p-3 space-y-2"
          key={offer.id}
        >
          <strong>
            {catalogue?.products.find((p) => p.id === offer.productId)?.name ||
              offer.selection?.product.name ||
              t('albumProducts.archived', 'Archived product')}
          </strong>
          <div className="flex flex-wrap gap-2">
            {guided && (
              <Badge tone={offer.enabled ? 'success' : 'neutral'}>
                {offer.enabled
                  ? t('albumProducts.released', 'Released')
                  : t('albumProducts.notReleased', 'Not released')}
              </Badge>
            )}
            <Badge tone={offer.status === 'locked' ? 'success' : 'neutral'}>
              {statusLabel(t, offer.status, clientFinal)}
            </Badge>
          </div>
          {offer.releasedCustomerId != null && (
            <p className="text-sm text-muted">
              {t('albumProducts.releasedTo', 'For {{name}} only', {
                name: audienceCustomer?.name || `#${offer.releasedCustomerId}`,
              })}
            </p>
          )}
          {offer.selection && guided ? (
            <AlbumChoiceDetails
              choice={offer.selection}
              renderPhoto={(photo) => <AdminAlbumPhoto eventId={eventId} photo={photo} />}
            />
          ) : (
            <p>
              {offer.selection ? (
                <ChoiceSummary choice={offer.selection} />
              ) : (
                t('albumProducts.noChoice', 'No choice yet')
              )}
            </p>
          )}
          {hasPermission('products.configure') &&
            (customers.length > 1 || offer.releasedCustomerId != null) && (
              <label className="block text-sm">
                {t('albumProducts.audience', 'Who gets this offer')}
                <select
                  className="input w-full"
                  disabled={busy || !!offer.selection}
                  value={offer.releasedCustomerId ?? ''}
                  onChange={(e) => changeAudience(offer, e.target.value)}
                >
                  <option value="">
                    {t('albumProducts.audienceClient', 'The gallery client (PIN)')}
                  </option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
          {offer.selection && (customers.length > 1 || offer.releasedCustomerId != null) && (
            <p className="text-sm text-muted">
              {t(
                'albumProducts.audienceFixed',
                'This offer holds a choice, so it stays with its customer. Add a new offer for another customer.',
              )}
            </p>
          )}
          {offer.enabled && offer.releasedCustomerId == null && customers.length > 1 && (
            <Notice tone="warning" size="sm">
              {t(
                'albumProducts.audienceShared',
                'Several customers share this gallery, so none of them sees this offer in the portal. Choose a customer, or use the PIN.',
              )}
            </Notice>
          )}
          {offer.selection && <OfferHistory eventId={eventId} offer={offer} />}
          {crmEnabled && billing.data && (
            <div className="space-y-2">
              <label className="block text-sm">
                {t('products.crmPriceSource', 'CRM catalogue price source')}
                <select
                  className="input w-full"
                  disabled={busy || offer.status === 'locked'}
                  value={offer.cataloguePresetId || ''}
                  onChange={(e) =>
                    priceSetting(offer, {
                      cataloguePresetId: e.target.value
                        ? Number(e.target.value)
                        : null,
                    })
                  }
                >
                  <option value="">
                    {t(
                      'products.choosePriceSource',
                      'Choose a price source before locking',
                    )}
                  </option>
                  {billing.data.presets
                    .filter((p) => p.product_id === offer.productId)
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} ({p.currency})
                      </option>
                    ))}
                </select>
              </label>
              {billing.data.customers.length > 1 && (
                <label className="block text-sm">
                  {t('products.billToCustomer', 'Bill to customer')}
                  <select
                    className="input w-full"
                    disabled={busy || offer.status === 'locked'}
                    value={offer.customerId || ''}
                    onChange={(e) =>
                      priceSetting(offer, {
                        customerId: e.target.value
                          ? Number(e.target.value)
                          : null,
                      })
                    }
                  >
                    <option value="">
                      {t(
                        'products.chooseCustomer',
                        'Choose an assigned customer',
                      )}
                    </option>
                    {billing.data.customers.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.display_name || c.email}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={!!offer.showPrices}
                  disabled={busy || offer.status === 'locked'}
                  onChange={(e) =>
                    priceSetting(offer, { showPrices: e.target.checked })
                  }
                />
                {t(
                  'products.showGalleryPrices',
                  'Show indicative prices to the client',
                )}
              </label>
              {billing.data.items
                .filter((i) => i.offer_id === offer.id)
                .map((i) => (
                  <p key={i.id} className="text-sm">
                    {i.invoice_id
                      ? t(
                          'products.billedOnInvoice',
                          'Billed on invoice #{{id}}',
                          { id: i.invoice_id },
                        )
                      : t('products.openBillable', 'Open product item')}{' '}
                    ·{' '}
                    {formatMoneyMinor(
                      JSON.parse(i.line_item).unit_price_minor,
                      i.currency,
                    )}
                  </p>
                ))}
            </div>
          )}
          {hasPermission('products.configure') && (
            <div className="flex gap-3 flex-wrap">
              <Button
                variant={guided && !offer.enabled ? 'primary' : 'secondary'}
                disabled={busy}
                onClick={() => change(offer, 'toggle')}
              >
                {guided
                  ? offer.enabled
                    ? t('albumProducts.withdraw', 'Withdraw release')
                    : t('albumProducts.release', 'Release to client')
                  : offer.enabled
                    ? t('albumProducts.hide', 'Hide offer')
                    : t('albumProducts.show', 'Show offer')}
              </Button>
              {guided && offer.enabled && slug && offer.releasedCustomerId != null && (
                <Button variant="ghost" disabled={busy} onClick={copyLink}>
                  {t('albumProducts.copyLink', 'Copy client link')}
                </Button>
              )}
              {canConfirm && offer.status === 'submitted' && (
                <Button disabled={busy} onClick={() => change(offer, 'lock')}>
                  {crmEnabled
                    ? t(
                        'products.lockAndBill',
                        'Lock choice and add to billing',
                      )
                    : t('albumProducts.lock', 'Lock choice')}
                </Button>
              )}
              {canConfirm && offer.status === 'locked' && !clientFinal && (
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => change(offer, 'unlock')}
                >
                  {t('albumProducts.unlock', 'Allow changes')}
                </Button>
              )}
              {canConfirm && clientFinal && (
                <Button variant="secondary" disabled={busy} onClick={() => reopen(offer)}>
                  {t('albumProducts.reopen', 'Reopen for the client')}
                </Button>
              )}
            </div>
          )}
        </div>
        );
      })}
      {hasPermission('products.configure') && (
        <div className="flex gap-3 flex-wrap">
          <label className="flex-1">
            {t('albumProducts.offerProduct', 'Offer a product')}
            <select
              className="input w-full"
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
            >
              <option value="">
                {t('albumProducts.chooseProduct', 'Choose a product')}
              </option>
              {catalogue?.products
                .filter(
                  (p) => p.active && !offers.some((o) => o.productId === p.id
                    && String(o.releasedCustomerId ?? '') === audience),
                )
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </select>
          </label>
          {customers.length > 1 && (
            <label className="flex-1">
              {t('albumProducts.audience', 'Who gets this offer')}
              <select
                className="input w-full"
                value={audience}
                onChange={(e) => {
                  setAudience(e.target.value);
                  setSelected('');
                }}
              >
                <option value="">
                  {t('albumProducts.audienceClient', 'The gallery client (PIN)')}
                </option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <Button disabled={busy || !selected} onClick={assign}>
            {t('albumProducts.assign', 'Add to gallery')}
          </Button>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3">
        {hasPermission('products.manage') && (
          <Link
            className="text-accent underline"
            to="/admin/settings?tab=albumProducts"
          >
            {t('albumProducts.manageCatalogue', 'Manage catalogue')}
          </Link>
        )}
        {crmEnabled &&
          hasPermission('customers.edit') &&
          [
            ...new Set(
              billing.data?.items
                .filter((i) => !i.invoice_id)
                .map((i) => i.customer_account_id),
            ),
          ].map((id) => (
            <Button key={id} disabled={busy} onClick={() => bill(id)}>
              {t(
                'products.billOpenProducts',
                'Create invoice for open product items',
              )}{' '}
              ·{' '}
              {billing.data?.customers.find((c) => c.id === id)?.display_name ||
                `#${id}`}
            </Button>
          ))}
      </div>
      {billing.isError && (
        <p role="alert" className="text-danger-text">
          {errorMessage(billing.error)}
        </p>
      )}
      {(error || query.isError) && (
        <p role="alert" className="text-danger-text">
          {error || errorMessage(query.error)}{' '}
          <Button variant="ghost" size="sm"
            onClick={() => load().catch((e) => setError(errorMessage(e)))}
          >
            {t('common.retry', 'Retry')}
          </Button>
        </p>
      )}
    </Card>
  );
}
export function EventProductsCard(props: { eventId: number; ownsEvent: boolean; slug?: string }) {
  const enabled = useFeatureEnabled('albumProducts'),
    { hasPermission } = usePermissions();
  return enabled && hasPermission('products.view') ? (
    <><PrintGallerySettings {...props} /><EventProducts {...props} /></>
  ) : null;
}
