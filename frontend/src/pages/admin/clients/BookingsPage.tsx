/**
 * Clients → Bookings (#2440, part 2). Three tabs:
 *   Requests  booking requests from the public page, pending first. Accept
 *             creates the customer, a project and a draft quote holding the
 *             estimate; decline frees the time and tells the client.
 *   Blocked   manual blocks (holidays, other work) on top of the business
 *             hours, gallery events and held requests.
 *   Settings  lead time, how far ahead, slot step, buffer, hold length, the
 *             intro text, and the link to the public page.
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { Copy, ExternalLink, Trash2 } from 'lucide-react';
import { Button, Card, Loading } from '../../../components/common';
import { PermissionGate } from '../../../components/admin/PermissionGate';
import { useLocalizedDate } from '../../../hooks/useLocalizedDate';
import { bookingService, type BookingRequest, type BookingSettings, type BookingStatus } from '../../../services/booking.service';
import { formatMoneyMinor } from '../../../utils/money';
import { zonedWallClock } from '../../../utils/zonedWallClock';
import { useFeatureEnabled } from '../../../contexts/FeatureFlagsContext';

type Tab = 'requests' | 'blocks' | 'settings';
const TABS: Tab[] = ['requests', 'blocks', 'settings'];

const inputCls = 'w-full px-3 py-2 rounded-md border border-line-strong bg-panel text-heading text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-panel';
const labelCls = 'block text-sm font-medium text-body mb-1';
const errorText = (err: any): string => err?.response?.data?.error || err?.message || 'Failed';

/** Invoices the deposit can be booked on: issued and still open (the server checks too). */
const openInvoices = (r: BookingRequest) => r.invoices.filter((i) => ['sent', 'overdue'].includes(i.status) && i.paidMinor < i.totalMinor);

const STATUS_CLS: Record<BookingStatus, string> = {
  awaiting_payment: 'bg-fill text-muted',
  pending: 'bg-warning-soft text-warning-text',
  accepted: 'bg-success-soft text-success-text',
  declined: 'bg-fill text-body',
  expired: 'bg-fill text-muted',
};

/** Date + time of an instant in the studio's zone, in the admin's formats. */
function useStudioTime(timezone: string) {
  const { format, formatTime } = useLocalizedDate();
  return (instant: string) => {
    const { day, time } = zonedWallClock(instant, timezone);
    return `${format(new Date(`${day}T12:00:00`))} ${formatTime(time)}`;
  };
}

const RequestsTab: React.FC<{ timezone: string }> = ({ timezone }) => {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const highlighted = Number(params.get('request')) || null;
  const { data: requests = [], isLoading } = useQuery({
    queryKey: ['booking-requests'],
    queryFn: () => bookingService.listRequests(),
  });
  const at = useStudioTime(timezone);
  const projectsOn = useFeatureEnabled('projects');
  const [declining, setDeclining] = useState<{ id: number; reason: string } | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [depositInvoice, setDepositInvoice] = useState<Record<number, number>>({});

  // Part 3: book a paid deposit on an invoice of the deal, open a gallery.
  const applyDeposit = async (r: BookingRequest) => {
    const invoiceId = depositInvoice[r.id] ?? openInvoices(r)[0]?.id;
    if (!invoiceId) return;
    setBusy(r.id);
    try {
      await bookingService.applyDeposit(r.id, invoiceId);
      toast.success(t('booking.admin.depositApplied', 'Deposit booked on the invoice.'));
      refresh();
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setBusy(null);
    }
  };
  const unlock = async (eventId: number) => {
    try {
      await bookingService.unlockGallery(eventId);
      toast.success(t('booking.admin.galleryUnlocked', 'Gallery opened.'));
      refresh();
    } catch (err) {
      toast.error(errorText(err));
    }
  };
  const depositLabel = (r: BookingRequest): string | null => {
    const amount = formatMoneyMinor(r.depositMinor, r.currency);
    switch (r.depositStatus) {
      case 'open': return t('booking.admin.deposit.open', 'Deposit {{amount}} not paid yet', { amount });
      case 'paid': return t('booking.admin.deposit.paid', 'Deposit {{amount}} paid by card', { amount });
      case 'refunded': return t('booking.admin.deposit.refunded', 'Deposit {{amount}} refunded', { amount });
      case 'refund_failed': return t('booking.admin.deposit.refundFailed', 'Deposit {{amount}}: the refund failed. Refund it in Stripe.', { amount });
      case 'expired': return t('booking.admin.deposit.expired', 'Deposit not paid; the checkout expired');
      case 'review': return t('booking.admin.deposit.review', 'A payment came in, but not the deposit amount. Check it in Stripe.');
      case 'disputed': return t('booking.admin.deposit.disputed', 'Deposit {{amount}}: the client opened a dispute. Answer it in Stripe.', { amount });
      default: return null;
    }
  };

  const refresh = () => qc.invalidateQueries({ queryKey: ['booking-requests'] });

  const accept = async (r: BookingRequest) => {
    setBusy(r.id);
    try {
      await bookingService.accept(r.id);
      toast.success(t('booking.admin.acceptedToast', 'Accepted. The draft quote is ready to review and send.'));
      refresh();
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const decline = async () => {
    if (!declining) return;
    setBusy(declining.id);
    try {
      await bookingService.decline(declining.id, declining.reason);
      setDeclining(null);
      refresh();
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const statusLabel = (s: BookingStatus) => ({
    awaiting_payment: t('booking.admin.status.awaitingPayment', 'Waiting for deposit'),
    pending: t('booking.admin.status.pending', 'Waiting'),
    accepted: t('booking.admin.status.accepted', 'Accepted'),
    declined: t('booking.admin.status.declined', 'Declined'),
    expired: t('booking.admin.status.expired', 'Hold expired'),
  })[s];

  if (isLoading) return <Loading />;
  if (requests.length === 0) {
    return <Card padding="lg"><p className="text-sm text-muted">{t('booking.admin.empty', 'No booking requests yet.')}</p></Card>;
  }

  return (
    <div className="space-y-3">
      {requests.map((r) => (
        <Card key={r.id} padding="lg" className={highlighted === r.id ? 'ring-2 ring-accent' : ''}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-heading">{r.serviceName}</span>
                <span className={`rounded px-1.5 py-0.5 text-[11px] ${STATUS_CLS[r.status]}`}>{statusLabel(r.status)}</span>
                <span className="text-xs text-muted">{r.reference}</span>
              </div>
              <div className="text-sm text-body">{at(r.startsAt)} – {zonedWallClock(r.endsAt, timezone).time}</div>
              <div className="text-sm text-body">
                {r.name}{r.company ? ` · ${r.company}` : ''} · <a className="text-accent hover:underline" href={`mailto:${r.email}`}>{r.email}</a>
                {r.phone ? ` · ${r.phone}` : ''}
              </div>
              {r.status === 'pending' && (
                <div className="text-xs text-muted">
                  {r.depositStatus === 'paid' || r.depositStatus === 'review'
                    // A paid deposit holds the time until you decide (no expiry).
                    ? t('booking.admin.heldPaid', 'Held until you decide (deposit paid)')
                    : t('booking.admin.heldUntil', 'Held until {{time}}', { time: at(r.holdExpiresAt) })}
                </div>
              )}
              {depositLabel(r) && (
                <div className={`text-xs ${['refund_failed', 'review', 'disputed'].includes(r.depositStatus) ? 'text-danger-text' : 'text-body'}`}>
                  {depositLabel(r)}
                  {r.depositAppliedMinor > 0 && ` · ${t('booking.admin.deposit.bookedAmount', '{{applied}} of it booked, last on invoice {{number}}', {
                    applied: formatMoneyMinor(r.depositAppliedMinor, r.currency),
                    number: r.invoices.find((i) => i.id === r.depositInvoiceId)?.number || `#${r.depositInvoiceId}`,
                  })}`}
                </div>
              )}
              {r.galleries.map((g) => (
                <div key={g.id} className="text-xs text-body flex items-center gap-2">
                  <span>
                    {g.locked
                      ? t('booking.admin.galleryLocked', 'Gallery "{{name}}" opens when every invoice is paid in PicPeak', { name: g.name })
                      : t('booking.admin.galleryOpen', 'Gallery "{{name}}" is open', { name: g.name })}
                  </span>
                  {g.locked && g.canUnlock && (
                    <PermissionGate permission="events.edit">
                      <button type="button" className="text-accent hover:underline" onClick={() => unlock(g.id)}>
                        {t('booking.admin.unlockNow', 'Open now')}
                      </button>
                    </PermissionGate>
                  )}
                </div>
              ))}
              {r.message && <p className="mt-2 text-sm text-body whitespace-pre-line">{r.message}</p>}
              {r.declineReason && <p className="mt-2 text-xs text-muted">{r.declineReason}</p>}
            </div>
            <div className="min-w-[14rem] text-sm">
              <div className="text-xs text-muted">{t('booking.admin.estimate', 'Estimate')}</div>
              <div className="text-lg font-semibold tabular-nums">{formatMoneyMinor(r.estimateMinor, r.currency)}</div>
              <ul className="mt-1 space-y-0.5 text-xs text-body">
                {r.estimateLines.map((l, i) => (
                  <li key={i} className="flex justify-between gap-3"><span>{l.description}</span><span className="tabular-nums">{formatMoneyMinor(l.totalMinor, r.currency)}</span></li>
                ))}
              </ul>
            </div>
          </div>
          {r.depositStatus === 'paid' && r.depositAppliedMinor < r.depositMinor && openInvoices(r).length > 0 && (
            // The route needs both: the booking (quotes) and the payment (bills).
            <PermissionGate permissions={['quotes.manage', 'bills.manage']} requireAll>
              <div className="mt-3 flex flex-wrap items-end justify-end gap-2">
                <div>
                  <label htmlFor={`deposit-invoice-${r.id}`} className={labelCls}>{t('booking.admin.depositInvoice', 'Book the deposit on')}</label>
                  <select id={`deposit-invoice-${r.id}`} className={`${inputCls} h-9`} value={depositInvoice[r.id] ?? openInvoices(r)[0].id}
                    onChange={(e) => setDepositInvoice({ ...depositInvoice, [r.id]: Number(e.target.value) })}>
                    {openInvoices(r).map((i) => (
                      <option key={i.id} value={i.id}>
                        {(i.number || `#${i.id}`)} · {formatMoneyMinor(i.totalMinor, i.currency)}
                      </option>
                    ))}
                  </select>
                </div>
                <Button variant="outline" size="sm" disabled={busy === r.id} onClick={() => applyDeposit(r)}>
                  {t('booking.admin.applyDeposit', 'Book deposit')}
                </Button>
              </div>
            </PermissionGate>
          )}
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            {r.quoteId && (
              <Link to={`/admin/clients/quotes/${r.quoteId}`}>
                <Button variant="outline" size="sm">{t('booking.admin.openQuote', 'Open quote')}</Button>
              </Link>
            )}
            {r.projectId && projectsOn && (
              <Link to={`/admin/clients/projects/${r.projectId}`}>
                <Button variant="outline" size="sm">{t('booking.admin.openProject', 'Open project')}</Button>
              </Link>
            )}
            {(r.status === 'pending' || r.status === 'expired') && (
              <PermissionGate permission="quotes.manage">
                <Button variant="outline" size="sm" disabled={busy === r.id}
                  onClick={() => setDeclining({ id: r.id, reason: '' })}>
                  {t('booking.admin.decline', 'Decline')}
                </Button>
              </PermissionGate>
            )}
            {(r.status === 'pending' || r.status === 'expired') && (
              // The route needs all three: new customer, project and quote.
              <PermissionGate permissions={['quotes.manage', 'customers.create', 'events.edit']} requireAll>
                <Button size="sm" disabled={busy === r.id} onClick={() => accept(r)}>
                  {t('booking.admin.accept', 'Accept and draft quote')}
                </Button>
              </PermissionGate>
            )}
          </div>
          {declining?.id === r.id && (
            <div className="mt-3 space-y-2">
              <label htmlFor={`decline-${r.id}`} className={labelCls}>{t('booking.admin.declineReason', 'Note to the client (optional)')}</label>
              <textarea id={`decline-${r.id}`} rows={2} maxLength={2000} className={inputCls} value={declining.reason}
                onChange={(e) => setDeclining({ ...declining, reason: e.target.value })} />
              <div className="flex justify-end gap-2">
                <Button variant="outline" size="sm" onClick={() => setDeclining(null)}>{t('common.cancel', 'Cancel')}</Button>
                <Button size="sm" disabled={busy === r.id} onClick={decline}>
                  {r.depositStatus === 'paid'
                    ? t('booking.admin.declineRefund', 'Decline, refund and tell the client')
                    : t('booking.admin.declineConfirm', 'Decline and tell the client')}
                </Button>
              </div>
            </div>
          )}
        </Card>
      ))}
    </div>
  );
};

const BlocksTab: React.FC<{ timezone: string }> = ({ timezone }) => {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const at = useStudioTime(timezone);
  const { data: blocks = [], isLoading } = useQuery({ queryKey: ['booking-blocks'], queryFn: () => bookingService.listBlocks() });
  const [form, setForm] = useState({ start: '', end: '', note: '' });

  // datetime-local is the admin's browser wall clock; the studio zone is
  // shown next to it so a block entered abroad is not misread.
  const save = async () => {
    try {
      await bookingService.createBlock({
        startsAt: new Date(form.start).toISOString(), endsAt: new Date(form.end).toISOString(), note: form.note || undefined,
      });
      setForm({ start: '', end: '', note: '' });
      qc.invalidateQueries({ queryKey: ['booking-blocks'] });
    } catch (err) {
      toast.error(errorText(err));
    }
  };
  const remove = async (id: number) => {
    try {
      await bookingService.deleteBlock(id);
      qc.invalidateQueries({ queryKey: ['booking-blocks'] });
    } catch (err) {
      toast.error(errorText(err));
    }
  };

  if (isLoading) return <Loading />;
  return (
    <div className="space-y-4">
      <p className="text-sm text-soft">
        {t('booking.admin.blocksIntro', 'Times nobody can book, on top of your business hours and the dates of your galleries.')}
      </p>
      <PermissionGate permission="quotes.manage">
        <Card padding="lg">
          <div className="grid grid-cols-1 md:grid-cols-[1fr_1fr_2fr_auto] gap-3 items-end">
            <div>
              <label htmlFor="block-start" className={labelCls}>{t('booking.admin.blockFrom', 'From')}</label>
              <input id="block-start" type="datetime-local" className={inputCls} value={form.start} onChange={(e) => setForm({ ...form, start: e.target.value })} />
            </div>
            <div>
              <label htmlFor="block-end" className={labelCls}>{t('booking.admin.blockTo', 'To')}</label>
              <input id="block-end" type="datetime-local" className={inputCls} value={form.end} onChange={(e) => setForm({ ...form, end: e.target.value })} />
            </div>
            <div>
              <label htmlFor="block-note" className={labelCls}>{t('booking.admin.blockNote', 'Note')}</label>
              <input id="block-note" maxLength={255} className={inputCls} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
            </div>
            <Button onClick={save} disabled={!form.start || !form.end}>{t('booking.admin.blockAdd', 'Block')}</Button>
          </div>
        </Card>
      </PermissionGate>
      <Card padding="lg">
        {blocks.length === 0 ? <p className="text-sm text-muted">{t('booking.admin.noBlocks', 'No blocked times.')}</p> : (
          <table className="w-full text-sm">
            <tbody>
              {blocks.map((b) => (
                <tr key={b.id} className="border-b border-line-faint">
                  <td className="py-2 text-body">{at(b.startsAt)} – {at(b.endsAt)}</td>
                  <td className="py-2 text-soft">{b.note}</td>
                  <td className="py-2 text-right">
                    <PermissionGate permission="quotes.manage">
                      <Button variant="outline" size="sm" aria-label={t('common.delete', 'Delete') as string} onClick={() => remove(b.id)}>
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    </PermissionGate>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
};

const NUMBER_FIELDS: Array<{ key: keyof BookingSettings; label: string; fallback: string; hint: string; hintFallback: string }> = [
  { key: 'leadTimeHours', label: 'booking.admin.field.leadTime', fallback: 'Minimum notice (hours)', hint: 'booking.admin.field.leadTimeHint', hintFallback: 'How long before a slot it can still be booked.' },
  { key: 'horizonDays', label: 'booking.admin.field.horizon', fallback: 'Bookable ahead (days)', hint: 'booking.admin.field.horizonHint', hintFallback: 'How far into the future clients can book.' },
  { key: 'slotStepMinutes', label: 'booking.admin.field.step', fallback: 'Start times every (minutes)', hint: 'booking.admin.field.stepHint', hintFallback: 'Offered start times, e.g. every 30 minutes.' },
  { key: 'bufferMinutes', label: 'booking.admin.field.buffer', fallback: 'Buffer (minutes)', hint: 'booking.admin.field.bufferHint', hintFallback: 'Kept free before and after every booking.' },
  { key: 'holdHours', label: 'booking.admin.field.hold', fallback: 'Hold a request for (hours)', hint: 'booking.admin.field.holdHint', hintFallback: 'An unanswered request frees its time after this.' },
  { key: 'maxOpenRequests', label: 'booking.admin.field.maxOpen', fallback: 'Open requests at most', hint: 'booking.admin.field.maxOpenHint', hintFallback: 'Beyond this, the page asks clients to write to you instead.' },
];

const SettingsTab: React.FC<{ settings: BookingSettings; timezone: string; hasBusinessHours: boolean }> = ({ settings, timezone, hasBusinessHours }) => {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [form, setForm] = useState(settings);
  const publicUrl = `${window.location.origin}/book`;

  const save = async () => {
    try {
      await bookingService.saveSettings(form);
      qc.invalidateQueries({ queryKey: ['booking-settings'] });
      toast.success(t('quotes.catalog.savedToast', 'Saved.'));
    } catch (err) {
      toast.error(errorText(err));
    }
  };

  return (
    <div className="space-y-4">
      <Card padding="lg">
        <div className="text-sm font-medium text-body mb-1">{t('booking.admin.publicLink', 'Public booking page')}</div>
        <div className="flex flex-wrap items-center gap-2">
          <code className="rounded bg-fill px-2 py-1 text-sm">{publicUrl}</code>
          <Button variant="outline" size="sm" onClick={() => { navigator.clipboard?.writeText(publicUrl); toast.success(t('booking.admin.copied', 'Link copied.')); }}>
            <Copy className="w-3.5 h-3.5 mr-1" />{t('booking.admin.copy', 'Copy')}
          </Button>
          <a href={publicUrl} target="_blank" rel="noreferrer">
            <Button variant="outline" size="sm"><ExternalLink className="w-3.5 h-3.5 mr-1" />{t('booking.admin.open', 'Open')}</Button>
          </a>
        </div>
        <p className="mt-2 text-xs text-muted">
          {t('booking.admin.servicesHint', 'Services show up there once they are marked bookable under Quotes → Catalogue → Services.')}
        </p>
      </Card>
      <Card padding="lg">
        <p className="text-sm text-soft mb-3">
          {hasBusinessHours
            ? t('booking.admin.hoursInfo', 'Clients can book within your business hours ({{zone}}).', { zone: timezone })
            : t('booking.admin.noHours', 'Set your business hours first: without them no time can be booked.')}
          {' '}
          <Link className="text-accent hover:underline" to="/admin/settings?tab=businessProfile">
            {t('booking.admin.editHours', 'Business hours')}
          </Link>
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {NUMBER_FIELDS.map((f) => (
            <div key={f.key}>
              <label htmlFor={`booking-${f.key}`} className={labelCls}>{t(f.label, f.fallback)}</label>
              <input id={`booking-${f.key}`} type="number" min={0} className={inputCls} value={String(form[f.key] ?? '')}
                onChange={(e) => setForm({ ...form, [f.key]: Number(e.target.value) })} />
              <p className="mt-1 text-xs text-muted">{t(f.hint, f.hintFallback)}</p>
            </div>
          ))}
          <div className="md:col-span-2">
            <label htmlFor="booking-intro" className={labelCls}>{t('booking.admin.field.intro', 'Text at the top of the booking page')}</label>
            <textarea id="booking-intro" rows={3} maxLength={5000} className={inputCls} value={form.introText || ''}
              onChange={(e) => setForm({ ...form, introText: e.target.value })} />
          </div>
        </div>
        <PermissionGate permission="quotes.manage">
          <div className="mt-4 flex justify-end"><Button onClick={save}>{t('common.save', 'Save')}</Button></div>
        </PermissionGate>
      </Card>
    </div>
  );
};

export const BookingsPage: React.FC = () => {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get('tab') as Tab | null;
  const tab: Tab = requested && TABS.includes(requested) ? requested : 'requests';
  const { data: settingsData, isLoading } = useQuery({
    queryKey: ['booking-settings'],
    queryFn: () => bookingService.getSettings(),
  });

  const tabLabel = (key: Tab) => ({
    requests: t('booking.admin.tab.requests', 'Requests'),
    blocks: t('booking.admin.tab.blocks', 'Blocked times'),
    settings: t('booking.admin.tab.settings', 'Settings'),
  })[key];

  if (isLoading || !settingsData) return <Loading />;
  const { timezone } = settingsData;

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-bold text-heading">{t('booking.admin.title', 'Bookings')}</h2>
      <div role="tablist" className="flex flex-wrap gap-1 border-b border-line">
        {TABS.map((key) => (
          <button key={key} role="tab" aria-selected={tab === key} onClick={() => setSearchParams({ tab: key })}
            className={`px-3 py-2 text-sm -mb-px border-b-2 ${tab === key ? 'border-accent text-heading font-medium' : 'border-transparent text-soft hover:text-heading'}`}>
            {tabLabel(key)}
          </button>
        ))}
      </div>
      {tab === 'requests' && <RequestsTab timezone={timezone} />}
      {tab === 'blocks' && <BlocksTab timezone={timezone} />}
      {tab === 'settings' && (
        <SettingsTab settings={settingsData.settings} timezone={timezone} hasBusinessHours={settingsData.hasBusinessHours} />
      )}
    </div>
  );
};
