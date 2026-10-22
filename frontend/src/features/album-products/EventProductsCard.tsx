import { useQuery } from '@tanstack/react-query';
import { ChoiceSummary } from './ConfigurationPicker';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Button, Card, Badge, Loading } from '../../components/common';
import { useFeatureEnabled } from '../../contexts/FeatureFlagsContext';
import { usePermissions } from '../../contexts/PermissionsContext';
import { albumProducts, errorMessage, type Offer } from './model';
import { api } from '../../config/api';
import { formatMoneyMinor } from '../../utils/money';
function EventProducts({ eventId }: { eventId: number }) {
  const { t } = useTranslation(),
    { hasPermission } = usePermissions();
  const [selected, setSelected] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const query = useQuery({
    queryKey: ['gallery-products', eventId],
    queryFn: () => albumProducts.event(eventId),
  });
  const catalogue = query.data?.catalogue,
    offers = query.data?.offers || [];
  const crmEnabled =
    useFeatureEnabled('bills') && hasPermission('bills.manage');
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
  const change = async (offer: Offer, action: 'lock' | 'unlock' | 'toggle') => {
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
      await albumProducts.assign(eventId, selected);
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
      {offers.map((offer) => (
        <div
          className="rounded border border-line p-3 space-y-2"
          key={offer.id}
        >
          <strong>
            {catalogue?.products.find((p) => p.id === offer.productId)?.name ||
              offer.selection?.product.name ||
              t('albumProducts.archived', 'Archived product')}
          </strong>
          <p>
            {offer.selection ? (
              <ChoiceSummary choice={offer.selection} />
            ) : (
              t('albumProducts.noChoice', 'No choice yet')
            )}
          </p>
          <Badge tone={offer.status === 'locked' ? 'success' : 'neutral'}>
            {offer.status === 'locked'
              ? t('albumProducts.locked', 'Locked by the studio')
              : offer.status === 'submitted'
                ? t('albumProducts.submitted', 'Submitted')
                : t('albumProducts.draft', 'Draft')}
          </Badge>
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
                variant="secondary"
                disabled={busy}
                onClick={() => change(offer, 'toggle')}
              >
                {offer.enabled
                  ? t('albumProducts.hide', 'Hide offer')
                  : t('albumProducts.show', 'Show offer')}
              </Button>
              {offer.status === 'submitted' && (
                <Button disabled={busy} onClick={() => change(offer, 'lock')}>
                  {crmEnabled
                    ? t(
                        'products.lockAndBill',
                        'Lock choice and add to billing',
                      )
                    : t('albumProducts.lock', 'Lock choice')}
                </Button>
              )}
              {offer.status === 'locked' && (
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => change(offer, 'unlock')}
                >
                  {t('albumProducts.unlock', 'Allow changes')}
                </Button>
              )}
            </div>
          )}
        </div>
      ))}
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
                  (p) => p.active && !offers.some((o) => o.productId === p.id),
                )
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </select>
          </label>
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
          <button
            className="underline"
            onClick={() => load().catch((e) => setError(errorMessage(e)))}
          >
            {t('common.retry', 'Retry')}
          </button>
        </p>
      )}
    </Card>
  );
}
export function EventProductsCard(props: { eventId: number }) {
  const enabled = useFeatureEnabled('albumProducts'),
    { hasPermission } = usePermissions();
  return enabled && hasPermission('products.view') ? (
    <EventProducts {...props} />
  ) : null;
}
