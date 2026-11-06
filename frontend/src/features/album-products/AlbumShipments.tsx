import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-toastify';
import { Trash2 } from 'lucide-react';
import { Badge, Button, Notice, useConfirm } from '../../components/common';
import { useLocalizedDate } from '../../hooks/useLocalizedDate';
import { usePermissions } from '../../contexts/PermissionsContext';
import { albumProducts, CARRIERS, errorMessage, isConfirmed, type Carrier, type Offer } from './model';

// Brand names, the same in every language.
const CARRIER_NAMES: Record<Exclude<Carrier, 'other'>, string> = {
  dhl: 'DHL',
  dhl_express: 'DHL Express',
  deutsche_post: 'Deutsche Post',
  dpd: 'DPD',
  hermes: 'Hermes',
  gls: 'GLS',
  ups: 'UPS',
  fedex: 'FedEx',
};

/**
 * The parcels sent for one album order (issue 2422). A parcel can only be
 * added once the client can no longer change the order; parcels already
 * recorded stay listed and deletable when the order is reopened.
 */
export function AlbumShipments({ eventId, offer }: { eventId: number; offer: Offer }) {
  const { t } = useTranslation(),
    { format: formatDate } = useLocalizedDate(),
    { hasPermission } = usePermissions(),
    confirm = useConfirm();
  const canEdit = hasPermission('products.configure'),
    canAdd = canEdit && isConfirmed(offer);
  const [carrier, setCarrier] = useState<Carrier>('dhl'),
    [number, setNumber] = useState(''),
    [url, setUrl] = useState(''),
    [notify, setNotify] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const query = useQuery({
    queryKey: ['gallery-product-shipments', eventId, offer.id],
    queryFn: () => albumProducts.shipments(eventId, offer.id),
  });
  const shipments = query.data?.shipments || [],
    recipient = query.data?.recipient ?? null;
  const carrierName = (key: Carrier) =>
    key === 'other' ? t('albumProducts.shipments.other', 'Other carrier') : CARRIER_NAMES[key];
  const add = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await albumProducts.addShipment(eventId, offer.id, {
        carrier,
        trackingNumber: number.trim(),
        ...(carrier === 'other' && url.trim() ? { trackingUrl: url.trim() } : {}),
        notify: notify && !!recipient,
      });
      if (result.notification === 'queued' && recipient)
        toast.success(
          t('albumProducts.shipments.addedMailed', 'Parcel recorded. Shipping e-mail queued to {{email}}.', {
            email: recipient.email,
          }),
        );
      else if (result.notification === 'failed')
        toast.warning(
          t('albumProducts.shipments.mailFailed', 'Parcel recorded, but the shipping e-mail could not be queued.'),
        );
      else toast.success(t('albumProducts.shipments.added', 'Parcel recorded.'));
      setNumber('');
      setUrl('');
      await query.refetch();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const remove = async (id: number, trackingNumber: string) => {
    const ok = await confirm({
      title: t('albumProducts.shipments.deleteTitle', 'Delete this parcel?'),
      message: t(
        'albumProducts.shipments.deleteMessage',
        'Parcel {{number}} disappears from the admin and from the customer portal. An e-mail already sent stays sent.',
        { number: trackingNumber },
      ),
      confirmLabel: t('albumProducts.shipments.delete', 'Delete parcel'),
      variant: 'danger',
    });
    if (!ok) return;
    setBusy(true);
    setError('');
    try {
      await albumProducts.removeShipment(eventId, offer.id, id);
      await query.refetch();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  if (!canAdd && !shipments.length && !query.isError) return null;
  return (
    <section className="space-y-2 border-t border-line pt-2" aria-label={t('albumProducts.shipments.title', 'Shipments')}>
      <h4 className="text-sm font-semibold text-heading">{t('albumProducts.shipments.title', 'Shipments')}</h4>
      {shipments.length > 0 && (
        <ul className="space-y-1 text-sm">
          {shipments.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-2">
              <span className="text-body">{s.carrierName || carrierName(s.carrier)}</span>
              {s.trackingUrl ? (
                <a
                  className="break-all text-accent underline"
                  href={s.trackingUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {s.trackingNumber}
                </a>
              ) : (
                <span className="break-all text-heading">{s.trackingNumber}</span>
              )}
              {s.shippedAt && <span className="text-muted">{formatDate(s.shippedAt)}</span>}
              <Badge tone={s.notifiedAt ? 'success' : 'neutral'}>
                {s.notifiedAt
                  ? t('albumProducts.shipments.mailed', 'E-mail sent')
                  : t('albumProducts.shipments.notMailed', 'Not notified')}
              </Badge>
              {canEdit && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  disabled={busy}
                  aria-label={t('albumProducts.shipments.deleteNamed', 'Delete parcel {{number}}', {
                    number: s.trackingNumber,
                  })}
                  onClick={() => remove(s.id, s.trackingNumber)}
                >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canAdd && query.isSuccess && (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-2">
            <label className="min-w-[10rem] flex-1 text-sm text-body">
              {t('albumProducts.shipments.carrier', 'Carrier')}
              <select
                className="input w-full"
                value={carrier}
                onChange={(e) => setCarrier(e.target.value as Carrier)}
              >
                {CARRIERS.map((key) => (
                  <option key={key} value={key}>
                    {carrierName(key)}
                  </option>
                ))}
              </select>
            </label>
            <label className="min-w-[10rem] flex-1 text-sm text-body">
              {t('albumProducts.shipments.number', 'Tracking number')}
              <input
                className="input w-full"
                value={number}
                maxLength={64}
                onChange={(e) => setNumber(e.target.value)}
              />
            </label>
          </div>
          {carrier === 'other' && (
            <label className="block text-sm text-body">
              {t('albumProducts.shipments.url', 'Tracking link (optional)')}
              <input
                className="input w-full"
                type="url"
                placeholder="https://"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
            </label>
          )}
          {recipient ? (
            <label className="flex items-start gap-2 text-sm text-body">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={notify}
                onChange={(e) => setNotify(e.target.checked)}
              />
              <span>
                {t('albumProducts.shipments.notify', 'Notify the customer by e-mail')}
                <span className="block text-xs text-muted">
                  {t('albumProducts.shipments.notifyTo', 'To {{name}} ({{email}}), with the tracking link.', {
                    name: recipient.name,
                    email: recipient.email,
                  })}
                </span>
              </span>
            </label>
          ) : (
            <Notice tone="warning" size="sm">
              {t(
                'albumProducts.shipments.noRecipient',
                'No customer account belongs to this order, so nobody can be notified and the portal cannot show the parcel. You can still record it.',
              )}
            </Notice>
          )}
          <Button size="sm" disabled={busy || !number.trim()} onClick={add}>
            {t('albumProducts.shipments.add', 'Add parcel')}
          </Button>
        </div>
      )}
      {(error || query.isError) && (
        <p role="alert" className="text-sm text-danger-text">
          {error || errorMessage(query.error)}{' '}
          {query.isError && (
            <Button variant="ghost" size="sm" onClick={() => query.refetch()}>
              {t('common.retry', 'Retry')}
            </Button>
          )}
        </p>
      )}
    </section>
  );
}
