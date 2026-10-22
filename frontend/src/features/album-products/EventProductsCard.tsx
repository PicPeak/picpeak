import { useQuery } from '@tanstack/react-query';
import { ChoiceSummary } from './ConfigurationPicker';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Button, Card, Badge, Loading } from '../../components/common';
import { useFeatureEnabled } from '../../contexts/FeatureFlagsContext';
import { usePermissions } from '../../contexts/PermissionsContext';
import { albumProducts, errorMessage, type Offer } from './model';
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
  const load = async () => {
    await query.refetch();
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
                  {t('albumProducts.lock', 'Lock choice')}
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
      {hasPermission('products.manage') && (
        <Link
          className="text-accent underline"
          to="/admin/settings?tab=albumProducts"
        >
          {t('albumProducts.manageCatalogue', 'Manage catalogue')}
        </Link>
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
