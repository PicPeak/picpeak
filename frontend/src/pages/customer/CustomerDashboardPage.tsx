/**
 * Customer dashboard (#354, #1444). Mounted at /customer/dashboard.
 *
 * Top to bottom:
 *   - Needs action — quotes waiting for an answer, contracts waiting for the
 *     customer's signature, invoices due or overdue, own uploads that were
 *     not accepted. Only sections for the customer's effective features are
 *     filled (server-side).
 *   - Recent — what happened lately (shared/uploaded/reviewed documents,
 *     contracts, quotes, invoices, galleries), derived server-side from the
 *     same visibility rules as the lists, so it can't show what those hide.
 *   - Galleries — inline rows with Open + Download, a sort dropdown, and a
 *     Details link to the per-event page.
 *   - Expired galleries — a history list with each gallery's expiry date.
 *     These can't be opened (decision #24c); Details still shows the event's
 *     documents.
 *
 * Whether a gallery is active, expired or not available yet comes from the
 * server (`availability`), not from the browser clock.
 *
 * Open → exchange the customer JWT for a per-event gallery JWT via
 * /api/customer/events/:slug/access-token, then navigate to /gallery/:slug.
 */
import React, { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AlertCircle, Calendar, Clock, Download, ExternalLink, History, ImageIcon, Info } from 'lucide-react';
import { toast } from 'react-toastify';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useLocalizedDate } from '../../hooks/useLocalizedDate';
import { useQuery } from '@tanstack/react-query';

import { Button, Loading } from '../../components/common';
import { formatMoneyMinor } from '../../utils/money';
import {
  customerService, type CustomerDashboard, type CustomerEvent, type CustomerRecentItem,
} from '../../services/customer.service';
import { galleryService } from '../../services/gallery.service';
import { storeGalleryToken, setActiveGallerySlug } from '../../utils/galleryAuthStorage';
import { calendarDay } from '../../utils/calendarDay';

type SortKey = 'newest' | 'oldest' | 'name';

const SORT_OPTIONS: Array<{ value: SortKey; labelKey: string; fallback: string }> = [
  { value: 'newest', labelKey: 'customer.dashboard.sortNewest', fallback: 'Newest first' },
  { value: 'oldest', labelKey: 'customer.dashboard.sortOldest', fallback: 'Oldest first' },
  { value: 'name', labelKey: 'customer.dashboard.sortName', fallback: 'By name' },
];

/**
 * Default to newest-first because that's almost always what a returning
 * customer wants ("which gallery did they upload yesterday?"). The other
 * orderings are mostly useful for archival browsing.
 */
const DEFAULT_SORT: SortKey = 'newest';

const surfaceStyle = {
  backgroundColor: 'var(--color-surface)',
  borderColor: 'var(--color-surface-border)',
};

const NeedsAction: React.FC<{ items: CustomerDashboard['needsAction'] }> = ({ items }) => {
  const { t } = useTranslation();
  const { format: fmtDate } = useLocalizedDate();
  const documents = items.documents ?? [];
  const requests = items.documentRequests ?? [];
  const total = items.quotes.length + items.contracts.length + items.invoices.length
    + documents.length + requests.length;
  if (total === 0) return null;

  return (
    <section aria-labelledby="needs-action-title" className="rounded-xl border mb-6 overflow-hidden" style={surfaceStyle}>
      <h2 id="needs-action-title" className="px-4 pt-4 pb-2 text-base font-semibold text-theme flex items-center gap-2">
        <Info className="w-5 h-5" />
        {t('customer.dashboard.needsAction', 'Needs your attention')}
      </h2>
      <ul className="divide-y" style={{ borderColor: 'var(--color-surface-border)' }}>
        {items.quotes.map((q) => (
          <li key={`q-${q.id}`} className="px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
            <span className="text-sm text-theme">
              {t('customer.dashboard.quoteAwaiting', 'Quote {{number}} is waiting for your answer', { number: q.quoteNumber })}
              {q.validUntil && (
                <span className="block text-xs text-muted-theme">
                  {t('customer.dashboard.validUntil', 'Valid until {{date}}', { date: fmtDate(q.validUntil) })}
                </span>
              )}
            </span>
            <Link to="/customer/quotes" className="text-sm underline text-theme">
              {t('customer.dashboard.viewQuote', 'View quote')}
            </Link>
          </li>
        ))}
        {items.contracts.map((c) => (
          <li key={`c-${c.id}`} className="px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
            <span className="text-sm text-theme">
              {t('customer.dashboard.contractAwaiting', 'Contract {{number}} is waiting for your signature', { number: c.contractNumber })}
              {c.title && <span className="block text-xs text-muted-theme">{c.title}</span>}
            </span>
            <Link to="/customer/contracts" className="text-sm underline text-theme">
              {t('customer.dashboard.viewContract', 'View contract')}
            </Link>
          </li>
        ))}
        {items.invoices.map((i) => (
          <li key={`i-${i.id}`} className="px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
            <span className="text-sm text-theme">
              {i.overdue
                ? t('customer.dashboard.invoiceOverdue', 'Invoice {{number}} is overdue', { number: i.invoiceNumber })
                : t('customer.dashboard.invoiceDue', 'Invoice {{number}} is due {{date}}', {
                  number: i.invoiceNumber, date: i.dueDate ? fmtDate(i.dueDate) : '',
                })}
              <span className={`block text-xs ${i.overdue ? 'text-status hue-danger' : 'text-muted-theme'}`}>
                {t('customer.dashboard.openAmount', 'Open: {{amount}}', { amount: formatMoneyMinor(i.openAmountMinor, i.currency) })}
              </span>
            </span>
            <Link to="/customer/bills" className="text-sm underline text-theme">
              {t('customer.dashboard.viewInvoice', 'View invoice')}
            </Link>
          </li>
        ))}
        {requests.map((r) => (
          <li key={`r-${r.id}`} className="px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
            <span className="text-sm text-theme break-words">
              {t('customer.dashboard.documentRequested', 'Please upload: {{title}}', { title: r.title })}
              {r.dueAt && (
                <span className="block text-xs text-muted-theme">
                  {t('customer.documents.requests.due', 'Needed by {{date}}', { date: fmtDate(calendarDay(r.dueAt)) })}
                </span>
              )}
            </span>
            <Link to={r.link} className="text-sm underline text-theme">
              {t('customer.dashboard.uploadDocument', 'Upload')}
            </Link>
          </li>
        ))}
        {documents.map((d) => (
          <li key={`d-${d.id}`} className="px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
            <span className="text-sm text-theme break-all">
              {t('customer.dashboard.documentRejected', '{{name}} was not accepted — upload a corrected version', { name: d.name })}
              {d.reviewNote && <span className="block text-xs text-muted-theme">{d.reviewNote}</span>}
            </span>
            <Link to={`/customer/documents/${d.id}`} className="text-sm underline text-theme">
              {t('customer.dashboard.viewDocument', 'View document')}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
};

function recentLabel(t: TFunction, item: CustomerRecentItem): string {
  const vars = { title: item.title };
  switch (item.kind) {
    case 'document_shared': return t('customer.dashboard.recent.documentShared', 'New document: {{title}}', vars);
    case 'document_uploaded': return t('customer.dashboard.recent.documentUploaded', 'You uploaded {{title}}', vars);
    case 'document_accepted': return t('customer.dashboard.recent.documentAccepted', '{{title}} was accepted', vars);
    case 'document_rejected': return t('customer.dashboard.recent.documentRejected', '{{title}} was not accepted', vars);
    case 'contract_sent': return t('customer.dashboard.recent.contractSent', 'Contract {{title}} was sent to you', vars);
    case 'contract_signed': return t('customer.dashboard.recent.contractSigned', 'You signed contract {{title}}', vars);
    case 'quote_sent': return t('customer.dashboard.recent.quoteSent', 'Quote {{title}} was sent to you', vars);
    case 'invoice_sent': return t('customer.dashboard.recent.invoiceSent', 'Invoice {{title}} was sent to you', vars);
    case 'gallery_assigned': return t('customer.dashboard.recent.galleryAssigned', 'Gallery {{title}} is now available to you', vars);
    default: return item.title;
  }
}

const Recent: React.FC<{ items: CustomerRecentItem[] }> = ({ items }) => {
  const { t } = useTranslation();
  const { format: fmtDate } = useLocalizedDate();
  if (items.length === 0) return null;
  return (
    <section aria-labelledby="recent-title" className="rounded-xl border mb-6 overflow-hidden" style={surfaceStyle}>
      <h2 id="recent-title" className="px-4 pt-4 pb-2 text-base font-semibold text-theme flex items-center gap-2">
        <History className="w-5 h-5" />
        {t('customer.dashboard.recentTitle', 'Recent')}
      </h2>
      <ul className="divide-y" style={{ borderColor: 'var(--color-surface-border)' }}>
        {items.map((item) => (
          <li key={`${item.kind}-${item.id}`} className="px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
            <Link to={item.link} className="text-sm text-theme hover:underline min-w-0 break-all">
              {recentLabel(t, item)}
            </Link>
            <time dateTime={item.at} className="text-xs text-muted-theme whitespace-nowrap">{fmtDate(item.at)}</time>
          </li>
        ))}
      </ul>
    </section>
  );
};

export const CustomerDashboardPage: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  // Localized date formatting — respects general_date_format + the active UI
  // language.
  const { format: fmtLocalized } = useLocalizedDate();

  const { data, isLoading, error } = useQuery({
    queryKey: ['customer-dashboard'],
    queryFn: () => customerService.getDashboard(),
  });

  const [openingSlug, setOpeningSlug] = useState<string | null>(null);
  const [downloadingSlug, setDownloadingSlug] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>(DEFAULT_SORT);

  const activeEvents = useMemo(() => data?.galleries.active ?? [], [data]);
  const expiredEvents = data?.galleries.expired ?? [];

  const sortedEvents = useMemo(() => {
    const list: CustomerEvent[] = activeEvents.slice();
    // Use eventDate (the wedding/shoot date) as the primary key for date
    // sorts; fall back to assignedAt when the event has no date set so
    // entries don't all collapse to the bottom.
    const dateOf = (e: CustomerEvent) => (e.eventDate || e.assignedAt || '');
    if (sort === 'newest') {
      list.sort((a, b) => dateOf(b).localeCompare(dateOf(a)));
    } else if (sort === 'oldest') {
      list.sort((a, b) => dateOf(a).localeCompare(dateOf(b)));
    } else {
      list.sort((a, b) => a.eventName.localeCompare(b.eventName, undefined, { sensitivity: 'base' }));
    }
    return list;
  }, [activeEvents, sort]);

  const openEvent = async (slug: string) => {
    if (openingSlug) return;
    setOpeningSlug(slug);
    try {
      const { token } = await customerService.getEventAccessToken(slug);
      storeGalleryToken(slug, token);
      setActiveGallerySlug(slug);
      navigate(`/gallery/${encodeURIComponent(slug)}`);
    } catch (e: any) {
      const status = e?.response?.status;
      if (status === 410) {
        toast.error(t('customer.dashboard.eventExpired', 'This gallery has expired.'));
      } else if (status === 403) {
        toast.error(t('customer.dashboard.eventForbidden', 'You no longer have access to this gallery.'));
      } else {
        toast.error(t('customer.dashboard.openError', 'Could not open this gallery. Please try again.'));
      }
    } finally {
      setOpeningSlug(null);
    }
  };

  const quickDownload = async (slug: string, eventName: string) => {
    if (downloadingSlug) return;
    setDownloadingSlug(slug);
    try {
      const { token } = await customerService.getEventAccessToken(slug);
      storeGalleryToken(slug, token);
      setActiveGallerySlug(slug);
      await galleryService.downloadAllPhotos(slug, false);
      toast.success(t('customer.dashboard.downloadStarted', 'Download started for {{name}}', { name: eventName }));
    } catch (e: any) {
      const status = e?.response?.status;
      if (status === 410) {
        toast.error(t('customer.dashboard.eventExpired', 'This gallery has expired.'));
      } else if (status === 403) {
        toast.error(t('customer.dashboard.eventForbidden', 'You no longer have access to this gallery.'));
      } else {
        toast.error(t('customer.dashboard.downloadError', 'Could not start the download. Please try again.'));
      }
    } finally {
      setDownloadingSlug(null);
    }
  };

  const formatDate = (iso: string | null) => {
    if (!iso) return null;
    try { return fmtLocalized(iso); } catch { return null; }
  };

  const detailsLink = (ev: CustomerEvent) => (
    <Link
      to={`/customer/events/${encodeURIComponent(ev.slug)}`}
      className="text-sm underline text-theme whitespace-nowrap"
      aria-label={t('customer.dashboard.detailsAria', 'Details for {{name}}', { name: ev.eventName })}
    >
      {t('customer.dashboard.details', 'Details')}
    </Link>
  );

  return (
    <div className="container py-6 sm:py-8">
      {isLoading ? (
        <div className="flex justify-center py-16"><Loading size="lg" /></div>
      ) : error || !data ? (
        <div role="alert" className="rounded-xl border p-6 flex items-start gap-3" style={surfaceStyle}>
          <AlertCircle className="w-5 h-5 mt-0.5 flex-shrink-0 text-status hue-danger" />
          <p className="text-theme">
            {t('customer.dashboard.loadError', 'Could not load your galleries. Please try again.')}
          </p>
        </div>
      ) : (
        <>
          <NeedsAction items={data.needsAction} />
          <Recent items={data.recent ?? []} />

          <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3 mb-6">
            <div>
              <h1 className="text-2xl font-bold text-theme">
                {t('customer.dashboard.title', 'Your galleries')}
              </h1>
              <p className="mt-1 text-sm text-muted-theme">
                {t('customer.dashboard.subtitle', 'Click a gallery to open it. The Download button bundles every photo as a zip.')}
              </p>
            </div>

            {/* Sort dropdown — only render when there's something to sort. */}
            {sortedEvents.length > 1 && (
              <div className="flex items-center gap-2">
                <label htmlFor="customer-events-sort" className="text-sm text-muted-theme whitespace-nowrap">
                  {t('customer.dashboard.sortLabel', 'Sort by')}
                </label>
                <select
                  id="customer-events-sort"
                  value={sort}
                  onChange={(e) => setSort(e.target.value as SortKey)}
                  className="rounded-lg border px-3 h-9 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
                  style={{ ...surfaceStyle, color: 'var(--color-text)' }}
                >
                  {SORT_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {t(opt.labelKey, opt.fallback)}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {sortedEvents.length === 0 ? (
            <div className="rounded-xl border p-6" style={surfaceStyle}>
              <div className="text-center py-12">
                <ImageIcon className="w-12 h-12 mx-auto mb-3 text-muted-theme" aria-hidden="true" />
                <h2 className="text-lg font-semibold text-theme mb-2">
                  {t('customer.dashboard.emptyTitle', 'No galleries yet')}
                </h2>
                <p className="text-sm text-muted-theme">
                  {t('customer.dashboard.emptyBody', 'Once your photographer assigns you to a gallery, it will appear here.')}
                </p>
              </div>
            </div>
          ) : (
            // Inline list — one row per gallery. Open and Download are
            // separate buttons so click bubbling doesn't cross-trigger.
            <div className="rounded-xl border overflow-hidden" style={surfaceStyle}>
              <ul className="divide-y" style={{ borderColor: 'var(--color-surface-border)' }}>
                {sortedEvents.map((ev) => {
                  const date = formatDate(ev.eventDate);
                  const expires = formatDate(ev.expiresAt);
                  const unavailable = ev.availability !== 'active';
                  const isOpening = openingSlug === ev.slug;
                  const isDownloading = downloadingSlug === ev.slug;
                  const rowDisabled = unavailable || openingSlug !== null || downloadingSlug !== null;
                  return (
                    <li
                      key={ev.id}
                      className="px-4 py-3 sm:px-5 sm:py-4 flex items-center gap-3 sm:gap-4"
                      style={{ borderColor: 'var(--color-surface-border)' }}
                    >
                      <div className="flex-1 min-w-0">
                        <h3 className="text-sm sm:text-base font-semibold text-theme truncate">
                          {ev.eventName}
                        </h3>
                        <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs sm:text-sm text-muted-theme">
                          {date && (
                            <span className="inline-flex items-center gap-1.5">
                              <Calendar className="w-3.5 h-3.5 flex-shrink-0" />
                              {date}
                            </span>
                          )}
                          {expires && (
                            <span className="inline-flex items-center gap-1.5">
                              <Clock className="w-3.5 h-3.5 flex-shrink-0" />
                              {t('customer.dashboard.expiresOn', 'Expires {{date}}', { date: expires })}
                            </span>
                          )}
                          {unavailable && (
                            <span>{t('customer.dashboard.notAvailable', 'Not available yet')}</span>
                          )}
                          {isOpening && (
                            <span className="text-xs" style={{ color: 'var(--color-accent)' }}>
                              {t('customer.dashboard.opening', 'Opening…')}
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="flex items-center gap-2 flex-shrink-0">
                        {detailsLink(ev)}
                        {!unavailable && (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => quickDownload(ev.slug, ev.eventName)}
                            disabled={rowDisabled}
                            leftIcon={<Download className="w-4 h-4" />}
                            aria-label={t('customer.dashboard.quickDownloadAria', 'Download all photos for {{name}}', { name: ev.eventName })}
                          >
                            <span className="hidden sm:inline">
                              {isDownloading
                                ? t('customer.dashboard.preparingDownload', 'Preparing…')
                                : t('customer.dashboard.download', 'Download')}
                            </span>
                          </Button>
                        )}
                        <Button
                          type="button"
                          variant="primary"
                          size="sm"
                          onClick={() => openEvent(ev.slug)}
                          disabled={rowDisabled}
                          leftIcon={<ExternalLink className="w-4 h-4" />}
                          aria-label={t('customer.dashboard.openAria', 'Open gallery {{name}}', { name: ev.eventName })}
                        >
                          <span className="hidden sm:inline">
                            {t('customer.dashboard.open', 'Open')}
                          </span>
                        </Button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {expiredEvents.length > 0 && (
            <section aria-labelledby="expired-galleries-title" className="mt-8">
              <h2 id="expired-galleries-title" className="text-lg font-semibold text-theme">
                {t('customer.dashboard.expiredTitle', 'Expired galleries')}
              </h2>
              <p className="mt-1 mb-3 text-sm text-muted-theme">
                {t('customer.dashboard.expiredHint', 'These galleries have expired and can no longer be opened. Contact your photographer if you still need the photos.')}
              </p>
              <div className="rounded-xl border overflow-hidden" style={surfaceStyle}>
                <ul className="divide-y" style={{ borderColor: 'var(--color-surface-border)' }}>
                  {expiredEvents.map((ev) => (
                    <li key={ev.id} className="px-4 py-3 sm:px-5 flex items-center gap-3">
                      <div className="flex-1 min-w-0">
                        <h3 className="text-sm font-medium text-theme truncate">{ev.eventName}</h3>
                        <p className="mt-0.5 text-xs text-muted-theme">
                          {ev.eventDate && <>{formatDate(ev.eventDate)}{' · '}</>}
                          {t('customer.dashboard.expiredOn', 'Expired {{date}}', { date: formatDate(ev.expiresAt) || '' })}
                        </p>
                      </div>
                      {detailsLink(ev)}
                    </li>
                  ))}
                </ul>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
};

export default CustomerDashboardPage;
