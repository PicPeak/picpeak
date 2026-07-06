/**
 * Customer dashboard (#354) — list of every gallery the admin has granted
 * this customer access to. Mounted at /customer/dashboard.
 *
 * Now a layout-wrapped page (Outlet child of CustomerLayout) — no inner
 * <CustomerLayout> wrapper.
 *
 * Design changes (#354 follow-up):
 *   - inline list rows instead of card grid (the maintainer asked for a
 *     denser, more spreadsheet-like view — works better when a customer
 *     has many recurring weddings)
 *   - sort dropdown: Name / Newest first / Oldest first
 *   - per-row Open + Download buttons (download bypasses the gallery and
 *     bundles a zip in one click)
 *
 * Card click → exchange the customer JWT for a per-event gallery JWT via
 * /api/customer/events/:slug/access-token, the backend writes the
 * gallery_token_<slug> cookie alongside the JSON response, then we navigate
 * to /gallery/:slug. The gallery code path needs no changes — it sees a
 * regular gallery token exactly as if the per-event password had been
 * entered.
 */
import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Calendar, Clock, Download, ExternalLink, ImageIcon, AlertCircle } from 'lucide-react';
import { toast } from 'react-toastify';
import { useTranslation } from 'react-i18next';
import { useLocalizedDate } from '../../hooks/useLocalizedDate';
import { useQuery } from '@tanstack/react-query';

import { Button, Loading } from '../../components/common';
import { customerService, type CustomerEvent } from '../../services/customer.service';
import { galleryService } from '../../services/gallery.service';
import { storeGalleryToken, setActiveGallerySlug } from '../../utils/galleryAuthStorage';

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

export const CustomerDashboardPage: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  // Localized date formatting — respects general_date_format + the active UI
  // language. Previously used raw date-fns `format(parseISO(iso),'PP')` with
  // no locale, so dates rendered en-US ("May", "Jun") under a German UI.
  const { format: fmtLocalized } = useLocalizedDate();

  const { data: events, isLoading, error } = useQuery({
    queryKey: ['customer-events'],
    queryFn: () => customerService.listEvents(),
  });

  const [openingSlug, setOpeningSlug] = useState<string | null>(null);
  const [downloadingSlug, setDownloadingSlug] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>(DEFAULT_SORT);

  const sortedEvents = useMemo(() => {
    const list: CustomerEvent[] = (events || []).slice();
    // Use eventDate (the wedding/shoot date) as the primary key for date
    // sorts; fall back to assignedAt when the event has no date set so
    // entries don't all collapse to the bottom. Name sort is a basic
    // case-insensitive locale compare.
    const dateOf = (e: CustomerEvent) => (e.eventDate || e.assignedAt || '');
    if (sort === 'newest') {
      list.sort((a, b) => dateOf(b).localeCompare(dateOf(a)));
    } else if (sort === 'oldest') {
      list.sort((a, b) => dateOf(a).localeCompare(dateOf(b)));
    } else {
      list.sort((a, b) => a.eventName.localeCompare(b.eventName, undefined, { sensitivity: 'base' }));
    }
    return list;
  }, [events, sort]);

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

  return (
    <div className="container py-6 sm:py-8">
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
        {(events?.length || 0) > 1 && (
          <div className="flex items-center gap-2">
            <label htmlFor="customer-events-sort" className="text-sm text-muted-theme whitespace-nowrap">
              {t('customer.dashboard.sortLabel', 'Sort by')}
            </label>
            <select
              id="customer-events-sort"
              value={sort}
              onChange={(e) => setSort(e.target.value as SortKey)}
              className="rounded-lg border px-3 h-9 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
              style={{
                backgroundColor: 'var(--color-surface)',
                borderColor: 'var(--color-surface-border)',
                color: 'var(--color-text)',
              }}
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

      {isLoading ? (
        <div className="flex justify-center py-16"><Loading size="lg" /></div>
      ) : error ? (
        <div
          role="alert"
          className="rounded-xl border p-6 flex items-start gap-3"
          style={{
            backgroundColor: 'var(--color-surface)',
            borderColor: 'var(--color-surface-border)',
          }}
        >
          <AlertCircle className="w-5 h-5 mt-0.5 flex-shrink-0 text-red-500" />
          <p className="text-theme">
            {t('customer.dashboard.loadError', 'Could not load your galleries. Please try again.')}
          </p>
        </div>
      ) : (sortedEvents.length === 0) ? (
        <div
          className="rounded-xl border p-6"
          style={{
            backgroundColor: 'var(--color-surface)',
            borderColor: 'var(--color-surface-border)',
          }}
        >
          <div className="text-center py-12">
            <ImageIcon className="w-12 h-12 mx-auto mb-3 text-muted-theme" aria-hidden="true" />
            <h2 className="text-lg font-semibold text-theme mb-2">
              {t('customer.dashboard.emptyTitle', 'No galleries yet')}
            </h2>
            <p className="text-sm text-muted-theme">
              {t(
                'customer.dashboard.emptyBody',
                'Once your photographer assigns you to a gallery, it will appear here.'
              )}
            </p>
          </div>
        </div>
      ) : (
        // Inline list — one row per gallery, no card grid. Hover affordance
        // via the entire row acting as a button (Open) plus a separate
        // Download icon button so click bubbling doesn't cross-trigger.
        <div
          className="rounded-xl border overflow-hidden"
          style={{
            backgroundColor: 'var(--color-surface)',
            borderColor: 'var(--color-surface-border)',
          }}
        >
          <ul className="divide-y" style={{ borderColor: 'var(--color-surface-border)' }}>
            {sortedEvents.map((ev) => {
              const date = formatDate(ev.eventDate);
              const expires = formatDate(ev.expiresAt);
              const isExpired = ev.expiresAt ? new Date(ev.expiresAt) < new Date() : false;
              const isOpening = openingSlug === ev.slug;
              const isDownloading = downloadingSlug === ev.slug;
              const rowDisabled = isExpired || openingSlug !== null || downloadingSlug !== null;
              return (
                <li
                  key={ev.id}
                  className="px-4 py-3 sm:px-5 sm:py-4 flex items-center gap-3 sm:gap-4"
                  style={{
                    borderColor: 'var(--color-surface-border)',
                    opacity: isExpired ? 0.6 : 1,
                  }}
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
                          {isExpired
                            ? t('customer.dashboard.expiredOn', 'Expired {{date}}', { date: expires })
                            : t('customer.dashboard.expiresOn', 'Expires {{date}}', { date: expires })}
                        </span>
                      )}
                      {isOpening && (
                        <span className="text-xs" style={{ color: 'var(--color-accent)' }}>
                          {t('customer.dashboard.opening', 'Opening…')}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-2 flex-shrink-0">
                    {!isExpired && (
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
    </div>
  );
};

export default CustomerDashboardPage;
