/**
 * Public quote accept/decline page. Mounted at /quote/:token (outside
 * any auth gate). The customer arrives here from the email button.
 *
 * Behaviour:
 *   - Reads the quote via /api/public/quotes/:token (no auth)
 *   - Shows the line items + totals (read-only)
 *   - Two big buttons: Accept / Decline
 *   - Within the response window (default 15 min) the customer can
 *     re-toggle. After the window the page shows a locked state and
 *     hides the buttons.
 *   - Localised based on the quote's stored language; falls back to
 *     browser language.
 */
import React, { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { publicQuotesService } from '../../services/quotes.service';
import { usePublicDarkMode } from '../../hooks/usePublicDarkMode';
import { useLocalizedDate } from '../../hooks/useLocalizedDate';
import { Loading } from '../../components/common';
import { formatMoney } from '../../utils/money';

/**
 * Format a date string as DD.MM.YYYY (the customer-facing format used
 * on the PDF too). Accepts ISO strings, Date objects, or already-short
 * "YYYY-MM-DD" forms; returns the original if parsing fails.
 */
import { formatShortDate } from '../../utils/dateShort';

export const QuoteResponsePage: React.FC = () => {
  const { t, i18n } = useTranslation();
  const { formatDateTime: fmtDateTime, formatTime: fmtTime } = useLocalizedDate();
  const { token } = useParams<{ token: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Apply dark mode per the branding settings (forced dark/light)
  // or fall back to the OS preference. Without this the public
  // quote page renders in light mode regardless of admin settings.
  // `isDark` drives the theme-aware logo pick below.
  const { isDark } = usePublicDarkMode();

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['public-quote', token],
    queryFn: () => publicQuotesService.get(token!),
    enabled: !!token,
    retry: false,
  });

  React.useEffect(() => {
    // Switch interface language to the quote's language if it differs
    // from the browser default — matches what the customer expects.
    if (data?.quote.language && data.quote.language !== i18n.language) {
      i18n.changeLanguage(data.quote.language).catch(() => {});
    }
  }, [data, i18n]);

  const q = data?.quote;
  // Tick state for the optional Terms of Service step. Pre-ticked if
  // the quote was already accepted (so re-displays don't lose state).
  const [tosAccepted, setTosAccepted] = useState(false);
  useEffect(() => {
    if (q?.tos?.acceptedAt) setTosAccepted(true);
  }, [q?.tos?.acceptedAt]);

  const handleRespond = React.useCallback(async (action: 'accept' | 'decline') => {
    setBusy(true);
    setError(null);
    try {
      await publicQuotesService.respond(token!, action, { tosAccepted });
      await refetch();
    } catch (err: any) {
      if (err?.response?.data?.code === 'RESPONSE_LOCKED') {
        setError(t('quoteResponse.locked', 'Your response window has closed and the decision is now final.'));
      } else if (err?.response?.data?.code === 'TOS_REQUIRED') {
        setError(t('quoteResponse.tosRequiredError',
          'Please tick "I accept the Terms of Service" before accepting the quote, or click Decline to refuse.'));
      } else {
        setError(err?.response?.data?.error || err.message || 'Something went wrong');
      }
    } finally { setBusy(false); }
  }, [token, refetch, t, tosAccepted]);

  // PRE-SELECTED ACTION FROM EMAIL LINK
  //
  // The Accept / Decline links in the customer email carry the chosen
  // action as a query string, e.g. /quote/<token>?action=accept.
  //
  // SECURITY: this MUST NOT auto-submit. Link prefetchers (Outlook
  // Safe Links, some Slack-like clients, Edge's tab-preview pre-fetch,
  // antivirus URL scanners) will GET the URL before the customer
  // ever clicks — auto-submission would silently flip the quote
  // state from a prefetch. Confirmed-clicked actions only.
  //
  // Instead we surface the intent via `preselectedAction` so the
  // matching CTA is visually highlighted on the page; the customer
  // confirms by clicking the on-page button. One human click is
  // required regardless of how they arrived.
  const preselectedAction = (() => {
    const raw = searchParams.get('action');
    return raw === 'accept' || raw === 'decline' ? raw : null;
  })();

  // Strip ?action= from the URL once the page is loaded so a refresh
  // doesn't keep the highlight (and so the URL in the browser bar /
  // history loses the action hint after first read). Idempotent.
  useEffect(() => {
    if (!searchParams.get('action')) return;
    const next = new URLSearchParams(searchParams);
    next.delete('action');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  if (isLoading) return (
    <div className="min-h-screen flex items-center justify-center bg-neutral-50 dark:bg-neutral-900">
      <Loading />
    </div>
  );

  if (isError || !data) {
    return (
      <div className="min-h-screen bg-neutral-50 dark:bg-neutral-900 flex items-center justify-center p-6">
        <div className="max-w-md text-center">
          <h1 className="text-2xl font-bold mb-2 text-neutral-900 dark:text-neutral-100">
            {t('quoteResponse.notFound', 'Quote not found')}
          </h1>
          <p className="text-neutral-600 dark:text-neutral-400">
            {t('quoteResponse.notFoundBody', 'This link may have expired or been revoked. Please contact the photographer for a new quote.')}
          </p>
        </div>
      </div>
    );
  }

  // Past the `if (isError || !data)` guard above, `data` is non-null —
  // so `data.quote` is the concrete Quote shape we render below. Hoist
  // it to a narrowed local instead of asserting `q!` on every property
  // access in the JSX. The original `q` stays around for the React
  // hooks declared above the guard (they MUST run on every render).
  const quote = data.quote;
  const locked = !quote.canRespond;
  const responseStatus = quote.respondedAt
    ? (quote.status === 'accepted' ? 'accepted' : quote.status === 'declined' ? 'declined' : 'pending')
    : 'pending';

  return (
    <div className="min-h-screen bg-neutral-50 dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100">
      <div className="max-w-3xl mx-auto py-8 px-4">
        {/* Issuer header — logo + company name. The logo URL is
            built server-side under /uploads/, so it works even on
            self-hosted Docker installs where the frontend can't reach
            the backend storage directory directly. */}
        {quote.issuer && (
          <div className="text-center mb-6">
            {(() => {
              const logo = isDark
                ? (quote.issuer.logoUrlDark || quote.issuer.logoUrl)
                : (quote.issuer.logoUrl || quote.issuer.logoUrlDark);
              return logo ? (
                <img
                  src={logo}
                  alt={quote.issuer.companyName || 'Logo'}
                  className="mx-auto mb-3 h-16 object-contain"
                />
              ) : null;
            })()}
            <h2 className="text-xl font-bold">{quote.issuer.companyName}</h2>
            {quote.issuer.website && (
              <p className="text-sm text-neutral-500 dark:text-neutral-400">{quote.issuer.website}</p>
            )}
          </div>
        )}

        <div className="bg-white dark:bg-neutral-800 rounded-xl shadow-sm border border-neutral-200 dark:border-neutral-700 p-6 md:p-8">
          <div className="flex items-baseline justify-between mb-4 gap-3 flex-wrap">
            <h1 className="text-2xl font-bold">{t('quoteResponse.title', 'Quote')} {quote.quoteNumber}</h1>
            <span className={`text-xs font-medium px-2 py-1 rounded ${
              quote.status === 'accepted' ? 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300'
                : quote.status === 'declined' ? 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300'
                : 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300'
            }`}>{t(`quotes.status.${quote.status}`, quote.status)}</span>
          </div>

          {quote.recipient && (
            <div className="mb-4 text-sm text-neutral-700 dark:text-neutral-300">
              <p className="font-medium">{quote.recipient.companyName || quote.recipient.displayName}</p>
              <p>{quote.recipient.email}</p>
            </div>
          )}

          {quote.eventName && (
            <p className="text-neutral-600 dark:text-neutral-400 mb-2">
              <strong>{t('quoteResponse.event', 'Event')}:</strong> {quote.eventName}
              {quote.eventDate && ` · ${formatShortDate(quote.eventDate)}`}
            </p>
          )}
          <p className="text-neutral-600 dark:text-neutral-400 mb-4">
            <strong>{t('quoteResponse.issueDate', 'Issued')}:</strong> {formatShortDate(quote.issueDate)}
            {quote.validUntil && ` · ${t('quoteResponse.validUntil', 'valid until')} ${formatShortDate(quote.validUntil)}`}
          </p>

          {quote.introText && (
            <p className="whitespace-pre-line text-neutral-700 dark:text-neutral-300 mb-4">{quote.introText}</p>
          )}

          <table className="w-full text-sm my-4">
            <thead>
              <tr className="border-b border-neutral-200 dark:border-neutral-700 text-neutral-600 dark:text-neutral-400">
                <th className="text-left py-2 w-10">#</th>
                <th className="text-left py-2">{t('quoteResponse.description', 'Description')}</th>
                <th className="text-right py-2 w-16">{t('quoteResponse.qty', 'Qty')}</th>
                <th className="text-right py-2 w-24">{t('quoteResponse.unit', 'Unit')}</th>
                <th className="text-right py-2 w-24">{t('quoteResponse.total', 'Total')}</th>
              </tr>
            </thead>
            <tbody>
              {(() => {
                // Migration 119 — sub-items + details_text. Top-level
                // items get a numeric position; sub-items show empty
                // position + indented description + parenthesised
                // (display-only) line total. A non-empty detailsText
                // renders as a small italic grey line directly below
                // its parent. Sub-items with unit_price = 0 leave the
                // price columns empty (transparency list only).
                let topCount = 0;
                const rows: React.ReactNode[] = [];
                for (const li of quote.lineItems) {
                  const isSub = li.parentLineItemId != null || li.parentPosition != null;
                  if (!isSub) topCount += 1;
                  const priceless = isSub && (!li.unitPriceMinor || Number(li.unitPriceMinor) === 0);
                  rows.push(
                    <tr key={`row-${li.position}`} className={`border-b border-neutral-100 dark:border-neutral-700/70 ${
                      isSub ? 'text-neutral-600 dark:text-neutral-400' : ''
                    }`}>
                      <td className="py-2">{isSub ? '' : topCount}</td>
                      <td className={`py-2 whitespace-pre-line ${isSub ? 'pl-6' : ''}`}>
                        {isSub ? '• ' : ''}{li.description}
                      </td>
                      <td className="py-2 text-right">{Number(li.quantity)}</td>
                      <td className="py-2 text-right tabular-nums">
                        {priceless ? '' : formatMoney(Number(li.unitPriceMinor) / 100, quote.currency)}
                      </td>
                      <td className={`py-2 text-right tabular-nums ${isSub ? 'italic' : ''}`}>
                        {priceless
                          ? ''
                          : isSub
                            ? `(${formatMoney(Number(li.lineTotalMinor) / 100, quote.currency)})`
                            : formatMoney(Number(li.lineTotalMinor) / 100, quote.currency)}
                      </td>
                    </tr>
                  );
                  if (li.detailsText && String(li.detailsText).trim().length > 0) {
                    rows.push(
                      <tr key={`details-${li.position}`} className="border-b border-neutral-100 dark:border-neutral-700/70">
                        <td className="py-1"></td>
                        <td className={`py-1 text-xs italic text-neutral-500 dark:text-neutral-400 whitespace-pre-line ${isSub ? 'pl-10' : 'pl-4'}`}
                          colSpan={4}>
                          {li.detailsText}
                        </td>
                      </tr>
                    );
                  }
                }
                return rows;
              })()}
            </tbody>
          </table>

          <div className="flex flex-col items-end gap-1 text-sm border-t border-neutral-200 dark:border-neutral-700 pt-3">
            <div className="flex gap-6"><span className="text-neutral-600 dark:text-neutral-400">{t('quoteResponse.subtotal', 'Subtotal')}:</span>
              <span className="tabular-nums w-28 text-right">{formatMoney(Number(quote.netAmountMinor) / 100, quote.currency)}</span></div>
            {quote.vatAmountMinor > 0 && (
              <div className="flex gap-6"><span className="text-neutral-600 dark:text-neutral-400">{t('quoteResponse.vat', 'VAT')} ({Number(quote.vatRate || 0).toFixed(1)}%):</span>
                <span className="tabular-nums w-28 text-right">{formatMoney(Number(quote.vatAmountMinor) / 100, quote.currency)}</span></div>
            )}
            <div className="flex gap-6 font-semibold text-base"><span>{t('quoteResponse.total', 'Total')}:</span>
              <span className="tabular-nums w-28 text-right">{formatMoney(Number(quote.totalAmountMinor) / 100, quote.currency)}</span></div>
          </div>

          {quote.outroText && (
            <p className="whitespace-pre-line text-neutral-700 dark:text-neutral-300 mt-4">{quote.outroText}</p>
          )}

          {/* Response area */}
          <div className="mt-8 pt-6 border-t border-neutral-200 dark:border-neutral-700 text-center">
            {error && <p className="text-red-600 dark:text-red-400 mb-4 text-sm">{error}</p>}
            {busy && (
              <p className="text-sm text-neutral-600 dark:text-neutral-400 mb-4">
                {t('quoteResponse.submitting', 'Recording your response…')}
              </p>
            )}
            {locked ? (
              <p className="text-sm text-neutral-600 dark:text-neutral-400">
                {responseStatus === 'accepted'
                  ? t('quoteResponse.acceptedLocked', 'You accepted this quote on {{date}}. The decision is final.', { date: quote.respondedAt ? fmtDateTime(quote.respondedAt) : '' })
                  : responseStatus === 'declined'
                    ? t('quoteResponse.declinedLocked', 'You declined this quote on {{date}}. The decision is final.', { date: quote.respondedAt ? fmtDateTime(quote.respondedAt) : '' })
                    : t('quoteResponse.cannotRespond', 'This quote can no longer be responded to via this link.')}
              </p>
            ) : (
              <>
                <p className="text-sm text-neutral-600 dark:text-neutral-400 mb-4">
                  {quote.respondedAt
                    ? t('quoteResponse.changeWithin', 'You can change your response until {{at}}.', (() => {
                        // Provide both variables so EN ("until {{at}}")
                        // and DE ("innerhalb von {{minutes}} Minuten")
                        // each render correctly without needing locale-
                        // specific call sites. `minutes` rounds UP so a
                        // 14m 32s remainder shows as "15 Minuten" — never
                        // promise a number the user can't actually hit.
                        const lockAt = quote.responseLockedAt ? new Date(quote.responseLockedAt) : null;
                        const minutes = lockAt
                          ? Math.max(0, Math.ceil((lockAt.getTime() - Date.now()) / 60000))
                          : 0;
                        return {
                          at: lockAt ? fmtTime(lockAt) : '',
                          minutes,
                        };
                      })())
                    : t('quoteResponse.intro', 'Please accept or decline this quote:')}
                </p>

                {/* Terms of Service step (admin-configurable in CRM
                    Settings). When `tos.required` is true, Accept is
                    disabled until the customer ticks the box. The
                    text + optional link come from settings; both can
                    be empty if only the checkbox + label is wanted. */}
                {quote.tos && (quote.tos.text || quote.tos.required) && (
                  <div className="text-left max-w-prose mx-auto mb-4 rounded-md border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-900 p-4">
                    {quote.tos.text && (
                      <div className="text-xs text-neutral-700 dark:text-neutral-300 whitespace-pre-line mb-3 max-h-48 overflow-y-auto">
                        {quote.tos.text}
                      </div>
                    )}
                    <label className="flex items-start gap-2 text-sm text-neutral-700 dark:text-neutral-300 cursor-pointer">
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={tosAccepted}
                        onChange={(e) => setTosAccepted(e.target.checked)}
                      />
                      <span>
                        {t('quoteResponse.tosCheckbox',
                          'I have read and accept the Terms of Service.')}
                        {quote.tos.url && (
                          <>
                            {' '}
                            <a href={quote.tos.url} target="_blank" rel="noopener noreferrer"
                              className="underline text-primary-600 dark:text-primary-400">
                              {t('quoteResponse.tosLink', 'Read the full Terms')}
                            </a>
                          </>
                        )}
                      </span>
                    </label>
                  </div>
                )}

                {/* Pre-selected from email link: gentle highlight on
                    the matching CTA via a glowing focus ring, plus a
                    short tip line. The customer still has to click —
                    see the preselectedAction comment above for why
                    auto-submit is unsafe (link prefetchers). */}
                {preselectedAction && (
                  <p className="text-center text-sm text-neutral-600 dark:text-neutral-300 mb-3">
                    {preselectedAction === 'accept'
                      ? t('quoteResponse.preselectAcceptHint', 'You followed the "Accept" link from the email — click the button below to confirm.')
                      : t('quoteResponse.preselectDeclineHint', 'You followed the "Decline" link from the email — click the button below to confirm.')}
                  </p>
                )}
                <div className="flex justify-center gap-3 flex-wrap">
                  <button
                    type="button"
                    disabled={busy || (quote.tos?.required && !tosAccepted)}
                    onClick={() => handleRespond('accept')}
                    className={`px-6 py-3 rounded-md bg-green-600 hover:bg-green-700 text-white font-medium disabled:opacity-50 ${
                      preselectedAction === 'accept' ? 'ring-4 ring-green-300 dark:ring-green-700 ring-offset-2 ring-offset-white dark:ring-offset-neutral-900' : ''
                    }`}
                  >{t('quoteResponse.accept', 'Accept quote')}</button>
                  <button
                    type="button" disabled={busy}
                    onClick={() => handleRespond('decline')}
                    className={`px-6 py-3 rounded-md border border-neutral-300 dark:border-neutral-600 hover:bg-neutral-50 dark:hover:bg-neutral-700 text-neutral-700 dark:text-neutral-200 font-medium disabled:opacity-50 ${
                      preselectedAction === 'decline' ? 'ring-4 ring-neutral-400 dark:ring-neutral-500 ring-offset-2 ring-offset-white dark:ring-offset-neutral-900' : ''
                    }`}
                  >{t('quoteResponse.decline', 'Decline')}</button>
                </div>
              </>
            )}
          </div>
        </div>

        {quote.issuer?.footerLine && (
          <p className="text-center text-xs text-neutral-500 dark:text-neutral-400 mt-4">{quote.issuer.footerLine}</p>
        )}
      </div>
    </div>
  );
};
