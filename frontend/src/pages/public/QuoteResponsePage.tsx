/**
 * Quote accept/decline page. Mounted at /quote/:token (outside any auth
 * gate) for the customer's email button, and inside the customer portal at
 * /customer/quotes/:id/respond.
 *
 * Behaviour:
 *   - The emailed link alone does not reveal the quote or the customer's
 *     personal data: the page first asks for a one-time code emailed to the
 *     customer (DocumentVerificationStep) and sends the resulting grant with
 *     every request. The portal uses its own session-authenticated routes
 *     (CustomerQuoteRespondPage), so no link token reaches the portal.
 *   - Shows the line items + totals (read-only)
 *   - Two big buttons: Accept / Decline
 *   - Within the response window (default 15 min) the customer can
 *     re-toggle. After the window the page shows a locked state and
 *     hides the buttons.
 *   - Localised based on the quote's stored language; falls back to
 *     browser language.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import {
  publicQuotesService,
  type PublicQuoteShell,
  type PublicQuoteView,
  type PublicSelectionTotals,
} from '../../services/quotes.service';
import { DocumentVerificationStep } from '../../components/public/DocumentVerificationStep';
import { usePublicDarkMode } from '../../hooks/usePublicDarkMode';
import { useLocalizedDate } from '../../hooks/useLocalizedDate';
import { Loading } from '../../components/common';
import { AddOnBookButton, AddOnBookingState } from '../../components/common/AddOnBookButton';
import { formatMoneyMinor } from '../../utils/money';
import {
  clearDocumentGrant,
  isVerificationRequired,
  readDocumentGrant,
  storeDocumentGrant,
  type DocumentAccessGrant,
  type DocumentVerificationSent,
} from '../../utils/documentAccess';

/**
 * Format a date string as DD.MM.YYYY (the customer-facing format used
 * on the PDF too). Accepts ISO strings, Date objects, or already-short
 * "YYYY-MM-DD" forms; returns the original if parsing fails.
 */
import { formatShortDate } from '../../utils/dateShort';

/** The longest message the server accepts with an acceptance. */
const MESSAGE_MAX_LENGTH = 2000;

/** Where the view reads and answers its quote: a public link or the portal. */
export interface QuoteDocumentAdapter {
  /** Query key for the quote; must change when access changes. */
  queryKey: readonly unknown[];
  load: () => Promise<{ quote: PublicQuoteView | PublicQuoteShell }>;
  respond: (action: 'accept' | 'decline', options: {
    tosAccepted?: boolean;
    /** The add-ons the customer booked, with the total the page showed (#1451). */
    selectedOptional?: number[];
    expectedTotalMinor?: number;
    /** A message to the business, sent with the acceptance. */
    customerMessage?: string;
  }) => Promise<unknown>;
  /** Live totals for a set of add-ons. Absent where booking isn't offered. */
  totals?: (selected: number[]) => Promise<PublicSelectionTotals>;
  /** Public links only: email a code, exchange it for a grant, drop the grant. */
  verification?: {
    requestCode: () => Promise<DocumentVerificationSent>;
    confirmCode: (code: string) => Promise<DocumentAccessGrant>;
    onVerified: (access: DocumentAccessGrant) => void;
    onAccessLost: () => void;
  };
}

const isShell = (q: PublicQuoteView | PublicQuoteShell): q is PublicQuoteShell =>
  q.verificationRequired === true;

export const QuoteResponseView: React.FC<{ adapter: QuoteDocumentAdapter }> = ({ adapter }) => {
  const { t, i18n } = useTranslation();
  const { formatDateTime: fmtDateTime, formatTime: fmtTime } = useLocalizedDate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [verificationNotice, setVerificationNotice] = useState<string | null>(null);
  // Optional message to the business, sent with the acceptance (#1451).
  const [message, setMessage] = useState('');
  // Apply dark mode per the branding settings (forced dark/light)
  // or fall back to the OS preference. Without this the public
  // quote page renders in light mode regardless of admin settings.
  // `isDark` drives the theme-aware logo pick below.
  const { isDark } = usePublicDarkMode();

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: adapter.queryKey,
    queryFn: adapter.load,
    retry: false,
  });

  React.useEffect(() => {
    // Switch interface language to the quote's language if it differs
    // from the browser default — matches what the customer expects.
    if (data?.quote.language && data.quote.language !== i18n.language) {
      i18n.changeLanguage(data.quote.language).catch(() => {});
    }
  }, [data, i18n]);

  const q = data && !isShell(data.quote) ? data.quote : undefined;
  // Tick state for the optional Terms of Service step. Pre-ticked if
  // the quote was already accepted (so re-displays don't lose state).
  const [tosAccepted, setTosAccepted] = useState(false);
  useEffect(() => {
    if (q?.tos?.acceptedAt) setTosAccepted(true);
  }, [q?.tos?.acceptedAt]);

  // Optional add-ons (#1451). The customer books the ones they want and the
  // server returns the totals for that choice. Accepting sends the choice
  // with the total shown here; the server recalculates and refuses a total
  // that doesn't match. While the response window is open an accepted quote
  // stays choosable: accepting again sends the changed choice.
  const offeredAddOns = React.useMemo(
    () => (q?.lineItems || []).filter((li) => li.isOptional && li.lineKind !== 'discount'
      && li.parentLineItemId == null && li.parentPosition == null),
    [q?.lineItems],
  );
  const [selection, setSelection] = useState<number[] | null>(null);
  useEffect(() => {
    if (selection === null && q) {
      setSelection(offeredAddOns.filter((li) => li.selected !== false).map((li) => li.position));
    }
  }, [q, offeredAddOns, selection]);
  // Booking needs live totals; the portal adapter doesn't offer them.
  const canChoose = !!q && !!adapter.totals && offeredAddOns.length > 0 && q.canRespond && !q.selectionLocked;
  const selectionKey = (selection || []).join(',');
  const totalsQuery = useQuery({
    queryKey: [...adapter.queryKey, 'totals', selectionKey],
    queryFn: () => adapter.totals!(selection || []),
    enabled: canChoose && selection !== null,
    retry: false,
  });
  // Keep the last totals on screen while the next choice is calculated.
  const [shownTotals, setShownTotals] = useState<PublicSelectionTotals | null>(null);
  useEffect(() => {
    if (totalsQuery.data) setShownTotals(totalsQuery.data);
  }, [totalsQuery.data]);
  const totalsReady = !canChoose || (!!shownTotals && !totalsQuery.isFetching);

  const handleRespond = React.useCallback(async (action: 'accept' | 'decline') => {
    setBusy(true);
    setError(null);
    const customerMessage = message.trim();
    try {
      await adapter.respond(action, {
        tosAccepted,
        // Booking sends the choice and its total. Where booking isn't offered
        // (the portal), the quote is accepted as it stands — with the total
        // this page showed, which the server still checks.
        ...(action === 'accept'
          ? (canChoose && shownTotals
            ? { selectedOptional: shownTotals.selectedOptional, expectedTotalMinor: shownTotals.totalAmountMinor }
            : { expectedTotalMinor: q?.totalAmountMinor })
          : {}),
        ...(action === 'accept' && customerMessage ? { customerMessage } : {}),
      });
      // The sent message is shown back from the server ("Your message").
      if (action === 'accept') setMessage('');
      await refetch();
    } catch (err: any) {
      const code = err?.response?.data?.code;
      if (adapter.verification && isVerificationRequired(err)) {
        // The grant ran out: back to the code step, keeping the chosen
        // action highlighted and the ToS tick.
        setVerificationNotice(t('documentVerification.sessionExpired',
          "For your security, please confirm it's you again.") as string);
        adapter.verification.onAccessLost();
      } else if (code === 'RESPONSE_LOCKED') {
        setError(t('quoteResponse.locked', 'Your response window has closed and the decision is now final.'));
      } else if (code === 'TOS_REQUIRED') {
        setError(t('quoteResponse.tosRequiredError',
          'Please tick "I accept the Terms of Service" before accepting the quote, or click Decline to refuse.'));
      } else if (code === 'TOTAL_MISMATCH') {
        setError(t('quoteResponse.addons.totalChanged', 'The total is now {{total}}. Please check it and accept again.', {
          total: formatMoneyMinor(Number(err.response.data.totalAmountMinor || 0), q?.currency || 'CHF'),
        }));
        await totalsQuery.refetch();
      } else {
        setError(err?.response?.data?.error || err.message || 'Something went wrong');
      }
    } finally { setBusy(false); }
  }, [adapter, refetch, t, tosAccepted, canChoose, shownTotals, totalsQuery, q?.currency, q?.totalAmountMinor, message]);

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
  //
  // Read once into state: the query string is stripped right away (below),
  // while the verification step may still be in front of the quote.
  const [preselectedAction] = useState<'accept' | 'decline' | null>(() => {
    const raw = searchParams.get('action');
    return raw === 'accept' || raw === 'decline' ? raw : null;
  });

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
    <div className="min-h-screen flex items-center justify-center bg-background">
      <Loading />
    </div>
  );

  const notFound = (
    <div className="min-h-screen bg-background flex items-center justify-center p-6">
      <div className="max-w-md text-center">
        <h1 className="text-2xl font-bold mb-2 text-theme">
          {t('quoteResponse.notFound', 'Quote not found')}
        </h1>
        <p className="text-muted-theme">
          {t('quoteResponse.notFoundBody', 'This link may have expired or been revoked. Please contact the photographer for a new quote.')}
        </p>
      </div>
    </div>
  );

  if (isError || !data) return notFound;

  if (isShell(data.quote)) {
    if (!adapter.verification) return notFound;
    const { verification } = adapter;
    return (
      <DocumentVerificationStep
        issuer={data.quote.issuer}
        emailHint={data.quote.emailHint}
        isDark={isDark}
        notice={verificationNotice}
        requestCode={verification.requestCode}
        confirmCode={verification.confirmCode}
        onVerified={(access) => {
          setVerificationNotice(null);
          verification.onVerified(access);
        }}
      />
    );
  }

  // Past the guards above, `data.quote` is the concrete full quote shape we
  // render below. Hoist it to a narrowed local instead of asserting on every
  // property access in the JSX. `q` stays around for the React hooks declared
  // above the guards (they MUST run on every render).
  const quote = data.quote;
  const locked = !quote.canRespond;
  const responseStatus = quote.respondedAt
    ? (quote.status === 'accepted' ? 'accepted' : quote.status === 'declined' ? 'declined' : 'pending')
    : 'pending';
  // Accepted, window still open: the add-ons can still be changed.
  const changeAddOnsUntil = canChoose && quote.status === 'accepted' && quote.responseLockedAt
    ? fmtTime(quote.responseLockedAt)
    : null;

  // While the customer chooses, lines and totals follow the server's numbers
  // for the current choice; otherwise they are the stored ones.
  const chosenSet = new Set(selection || []);
  const isChosen = (position: number, selectedFlag?: boolean) => (
    canChoose ? chosenSet.has(position) : selectedFlag !== false
  );
  const lineTotalOverrides = new Map<number, number>(
    canChoose && shownTotals ? shownTotals.lines.map((l) => [l.position, l.lineTotalMinor]) : [],
  );
  const shown = canChoose && shownTotals ? shownTotals : quote;
  const toggleAddOn = (position: number, on: boolean) => {
    setError(null);
    setSelection((prev) => {
      const next = new Set(prev || []);
      if (on) next.add(position); else next.delete(position);
      return [...next].sort((a, b) => a - b);
    });
  };

  return (
    <div className="min-h-screen bg-background text-theme">
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
              <p className="text-sm text-muted-theme">{quote.issuer.website}</p>
            )}
          </div>
        )}

        <div className="bg-surface rounded-xl shadow-sm border border-border-token p-6 md:p-8">
          <div className="flex items-baseline justify-between mb-4 gap-3 flex-wrap">
            <h1 className="text-2xl font-bold">{t('quoteResponse.title', 'Quote')} {quote.quoteNumber}</h1>
            <span className={`text-xs font-medium px-2 py-1 rounded status-chip ${
              quote.status === 'accepted' ? 'hue-success'
                : quote.status === 'declined' ? 'hue-danger'
                : 'hue-info'
            }`}>{t(`quotes.status.${quote.status}`, quote.status)}</span>
          </div>

          {quote.recipient && (
            <div className="mb-4 text-sm text-theme">
              <p className="font-medium">{quote.recipient.companyName || quote.recipient.displayName}</p>
              <p>{quote.recipient.email}</p>
            </div>
          )}

          {quote.eventName && (
            <p className="text-muted-theme mb-2">
              <strong>{t('quoteResponse.event', 'Event')}:</strong> {quote.eventName}
              {quote.eventDate && ` · ${formatShortDate(quote.eventDate)}`}
            </p>
          )}
          <p className="text-muted-theme mb-4">
            <strong>{t('quoteResponse.issueDate', 'Issued')}:</strong> {formatShortDate(quote.issueDate)}
            {quote.validUntil && ` · ${t('quoteResponse.validUntil', 'valid until')} ${formatShortDate(quote.validUntil)}`}
          </p>

          {quote.introText && (
            <p className="whitespace-pre-line text-theme mb-4">{quote.introText}</p>
          )}

          {canChoose && (
            <p className="text-sm text-muted-theme">
              {changeAddOnsUntil
                ? t('quoteResponse.addons.changeUntil', 'You can change your add-ons until {{time}}. Accept again to confirm a change.', { time: changeAddOnsUntil })
                : t('quoteResponse.addons.hint', 'Book the add-ons you would like. The total updates as you choose.')}
            </p>
          )}

          {/* On a phone the unit price column steps aside (quantity and total
              stay); anything still too wide scrolls inside the card. */}
          <div className="overflow-x-auto my-4">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border-token text-muted-theme">
                  <th className="text-left py-2 w-10">#</th>
                  <th className="text-left py-2">{t('quoteResponse.description', 'Description')}</th>
                  <th className="text-right py-2 pl-2 sm:pl-4 w-16 whitespace-nowrap">{t('quoteResponse.qty', 'Qty')}</th>
                  <th className="hidden sm:table-cell text-right py-2 pl-4 w-24 whitespace-nowrap">{t('quoteResponse.unit', 'Unit')}</th>
                  <th className="text-right py-2 pl-2 sm:pl-4 w-24 whitespace-nowrap">{t('quoteResponse.total', 'Total')}</th>
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
                  // A package whose price is the sum of its sub-items has no
                  // unit price of its own — the same rule as the PDF.
                  const parents = new Set<string>();
                  for (const item of quote.lineItems) {
                    if (item.parentLineItemId != null) parents.add(`id:${item.parentLineItemId}`);
                    if (item.parentPosition != null) parents.add(`pos:${item.parentPosition}`);
                  }
                  for (const li of quote.lineItems) {
                    const isSub = li.parentLineItemId != null || li.parentPosition != null;
                    // Discount lines (#1451) are numbered, but carry no quantity or unit price.
                    const isDiscount = li.lineKind === 'discount';
                    if (!isSub) topCount += 1;
                    const priceless = isSub && (!li.unitPriceMinor || Number(li.unitPriceMinor) === 0);
                    const packageSum = !isSub && !Number(li.unitPriceMinor)
                      && (parents.has(`id:${li.id}`) || parents.has(`pos:${li.position}`));
                    const unitLabel = li.unit ? t(`crm.lineItems.unitShort.${li.unit}`, li.unit) : '';
                    const quantityText = isDiscount
                      ? ''
                      : li.unit === 'flat' ? unitLabel : `${Number(li.quantity)}${unitLabel ? ` ${unitLabel}` : ''}`;
                    // Optional add-ons (#1451): sub-items follow their parent.
                    const addOnPosition = isSub ? li.parentPosition : li.position;
                    const isAddOn = !!li.isOptional && !isDiscount;
                    const addOnChosen = isAddOn && addOnPosition != null ? isChosen(addOnPosition, li.selected) : true;
                    // A not-booked add-on is dimmed — except its Book button.
                    const dim = addOnChosen ? '' : 'opacity-60';
                    const lineTotalMinor = lineTotalOverrides.get(li.position) ?? Number(li.lineTotalMinor);
                    const hasDetails = !!li.detailsText && String(li.detailsText).trim().length > 0;
                    // An add-on's status (with its Book / Remove booking button)
                    // is the last line of the item: title, details, status.
                    const hasStatus = isAddOn && !isSub;
                    const itemBorder = 'border-b border-border-token';
                    rows.push(
                      <tr key={`row-${li.position}`} className={`${hasDetails || hasStatus ? '' : itemBorder} ${
                        isSub ? 'text-muted-theme' : ''
                      }`}>
                        <td className={`py-2 ${dim}`}>{isSub ? '' : topCount}</td>
                        <td className={`py-2 whitespace-pre-line ${isSub ? 'pl-6' : ''} ${dim}`}>
                          {isSub ? '• ' : ''}{li.description}
                          {hasStatus && canChoose && (
                            <span className="ml-2 inline-block rounded px-1.5 py-0.5 text-xs bg-elevated text-theme">
                              {t('quoteResponse.addons.optional', 'Optional')}
                            </span>
                          )}
                        </td>
                        <td className={`py-2 pl-2 sm:pl-4 text-right whitespace-nowrap ${dim}`}>{quantityText}</td>
                        <td className={`hidden sm:table-cell py-2 pl-4 text-right tabular-nums whitespace-nowrap ${dim}`}>
                          {priceless || isDiscount || packageSum ? '' : formatMoneyMinor(Number(li.unitPriceMinor), quote.currency)}
                        </td>
                        <td className={`py-2 pl-2 sm:pl-4 text-right tabular-nums whitespace-nowrap ${isSub ? 'italic' : ''} ${dim}`}>
                          {priceless
                            ? ''
                            : isSub
                              ? `(${formatMoneyMinor(lineTotalMinor, quote.currency)})`
                              : formatMoneyMinor(lineTotalMinor, quote.currency)}
                        </td>
                      </tr>
                    );
                    if (hasDetails) {
                      rows.push(
                        <tr key={`details-${li.position}`} className={hasStatus ? '' : itemBorder}>
                          <td className="py-1"></td>
                          <td className={`py-1 text-xs italic text-muted-theme whitespace-pre-line ${isSub ? 'pl-10' : 'pl-4'} ${dim}`}
                            colSpan={4}>
                            {li.detailsText}
                          </td>
                        </tr>
                      );
                    }
                    if (hasStatus) {
                      rows.push(
                        <tr key={`status-${li.position}`} className={itemBorder}>
                          <td className="pb-2"></td>
                          <td className="pb-2" colSpan={4}>
                            {canChoose ? (
                              <div className="flex items-center gap-2 flex-wrap text-xs">
                                <span className={`italic text-muted-theme ${dim}`}>
                                  <AddOnBookingState booked={addOnChosen} />
                                </span>
                                <AddOnBookButton
                                  booked={addOnChosen}
                                  disabled={busy}
                                  onToggle={() => toggleAddOn(li.position, !addOnChosen)}
                                />
                              </div>
                            ) : (
                              <span className={`inline-block rounded px-1.5 py-0.5 text-xs bg-elevated text-theme ${dim}`}>
                                {addOnChosen
                                  ? t('quoteResponse.addons.included', 'Booked')
                                  : t('quoteResponse.addons.notChosen', 'Not booked')}
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    }
                  }
                  return rows;
                })()}
              </tbody>
            </table>
          </div>

          <div className="flex flex-col items-end gap-1 text-sm border-t border-border-token pt-3">
            <div className="flex gap-6"><span className="text-muted-theme">{t('quoteResponse.subtotal', 'Subtotal')}:</span>
              <span className="tabular-nums w-28 text-right">{formatMoneyMinor(Number(shown.netAmountMinor), quote.currency)}</span></div>
            {shown.vatAmountMinor > 0 && (
              <div className="flex gap-6"><span className="text-muted-theme">{t('quoteResponse.vat', 'VAT')} ({Number(quote.vatRate || 0).toFixed(1)}%):</span>
                <span className="tabular-nums w-28 text-right">{formatMoneyMinor(Number(shown.vatAmountMinor), quote.currency)}</span></div>
            )}
            <div className="flex gap-6 font-semibold text-base"><span>{t('quoteResponse.total', 'Total')}:</span>
              <span className="tabular-nums w-28 text-right">{formatMoneyMinor(Number(shown.totalAmountMinor), quote.currency)}</span></div>
            {canChoose && totalsQuery.isFetching && (
              <p className="text-xs text-muted-theme" aria-live="polite">
                {t('quoteResponse.addons.updating', 'Updating the total…')}
              </p>
            )}
          </div>

          {quote.outroText && (
            <p className="whitespace-pre-line text-theme mt-4">{quote.outroText}</p>
          )}

          {/* Response area */}
          <div className="mt-8 pt-6 border-t border-border-token text-center">
            {error && <p className="text-danger-text mb-4 text-sm">{error}</p>}
            {busy && (
              <p className="text-sm text-muted-theme mb-4">
                {t('quoteResponse.submitting', 'Recording your response…')}
              </p>
            )}
            {/* What the customer wrote with their acceptance, shown back. */}
            {quote.customerMessage && quote.status !== 'declined' && (
              <div className="text-left max-w-prose mx-auto mb-4 rounded-md border border-border-token bg-elevated p-4">
                <p className="text-xs font-medium text-muted-theme mb-1">
                  {t('quoteResponse.message.yours', 'Your message')}
                </p>
                <p className="text-sm whitespace-pre-wrap break-words text-theme">{quote.customerMessage}</p>
              </div>
            )}
            {locked ? (
              <p className="text-sm text-muted-theme">
                {responseStatus === 'accepted'
                  ? t('quoteResponse.acceptedLocked', 'You accepted this quote on {{date}}. The decision is final.', { date: quote.respondedAt ? fmtDateTime(quote.respondedAt) : '' })
                  : responseStatus === 'declined'
                    ? t('quoteResponse.declinedLocked', 'You declined this quote on {{date}}. The decision is final.', { date: quote.respondedAt ? fmtDateTime(quote.respondedAt) : '' })
                    : t('quoteResponse.cannotRespond', 'This quote can no longer be responded to via this link.')}
              </p>
            ) : (
              <>
                <p className="text-sm text-muted-theme mb-4">
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
                  <div className="text-left max-w-prose mx-auto mb-4 rounded-md border border-border-token bg-elevated p-4">
                    {quote.tos.text && (
                      <div className="text-xs text-theme whitespace-pre-line mb-3 max-h-48 overflow-y-auto">
                        {quote.tos.text}
                      </div>
                    )}
                    <label className="flex items-start gap-2 text-sm text-theme cursor-pointer">
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
                              className="underline text-accent">
                              {t('quoteResponse.tosLink', 'Read the full Terms')}
                            </a>
                          </>
                        )}
                      </span>
                    </label>
                  </div>
                )}

                {/* Optional message to the business, sent with Accept. */}
                <div className="text-left max-w-prose mx-auto mb-4">
                  <label htmlFor="quote-customer-message"
                    className="block text-sm font-medium text-theme mb-1">
                    {t('quoteResponse.message.label', 'Your message to us (optional)')}
                  </label>
                  <textarea
                    id="quote-customer-message"
                    rows={3}
                    maxLength={MESSAGE_MAX_LENGTH}
                    value={message}
                    disabled={busy}
                    onChange={(e) => setMessage(e.target.value)}
                    placeholder={t('quoteResponse.message.placeholder', 'Anything we should know? It is sent with your acceptance.')}
                    className="input-themed h-auto"
                  />
                </div>

                {/* Pre-selected from email link: gentle highlight on
                    the matching CTA via a glowing focus ring, plus a
                    short tip line. The customer still has to click —
                    see the preselectedAction comment above for why
                    auto-submit is unsafe (link prefetchers). */}
                {preselectedAction && (
                  <p className="text-center text-sm text-muted-theme mb-3">
                    {preselectedAction === 'accept'
                      ? t('quoteResponse.preselectAcceptHint', 'You followed the "Accept" link from the email — click the button below to confirm.')
                      : t('quoteResponse.preselectDeclineHint', 'You followed the "Decline" link from the email — click the button below to confirm.')}
                  </p>
                )}
                <div className="flex justify-center gap-3 flex-wrap">
                  <button
                    type="button"
                    disabled={busy || (quote.tos?.required && !tosAccepted) || !totalsReady}
                    onClick={() => handleRespond('accept')}
                    className={`px-6 py-3 rounded-md bg-success hover:opacity-90 text-white font-medium disabled:opacity-50 ${
                      preselectedAction === 'accept' ? 'ring-4 ring-success ring-offset-2 ring-offset-surface' : ''
                    }`}
                  >{t('quoteResponse.accept', 'Accept quote')}</button>
                  <button
                    type="button" disabled={busy}
                    onClick={() => handleRespond('decline')}
                    className={`px-6 py-3 rounded-md border border-border-token hover:bg-elevated text-theme font-medium disabled:opacity-50 ${
                      preselectedAction === 'decline' ? 'ring-4 ring-text-secondary ring-offset-2 ring-offset-surface' : ''
                    }`}
                  >{t('quoteResponse.decline', 'Decline')}</button>
                </div>
              </>
            )}
          </div>
        </div>

        {quote.issuer?.footerLine && (
          <p className="text-center text-xs text-muted-theme mt-4">{quote.issuer.footerLine}</p>
        )}
      </div>
    </div>
  );
};

/** Public route `/quote/:token`: the emailed link, gated by the one-time code. */
export const QuoteResponsePage: React.FC = () => {
  const { token = '' } = useParams<{ token: string }>();
  const [grant, setGrant] = useState<string | null>(() => (token ? readDocumentGrant('quote', token) : null));
  // Bumped whenever access changes so the quote is fetched again with (or
  // without) the grant. The grant itself stays out of the query cache key.
  const [accessVersion, setAccessVersion] = useState(0);

  const adapter = useMemo<QuoteDocumentAdapter>(() => ({
    queryKey: ['public-quote', token, accessVersion],
    load: async () => {
      const result = await publicQuotesService.get(token, grant);
      // The server answered with the verification shell although we sent a
      // grant: it expired or was revoked, so don't offer it again.
      if (grant && isShell(result.quote)) clearDocumentGrant('quote', token);
      return result;
    },
    respond: (action, options) => publicQuotesService.respond(token, action, options, grant),
    totals: (selected) => publicQuotesService.totals(token, selected, grant),
    verification: {
      requestCode: () => publicQuotesService.requestVerification(token),
      confirmCode: (code) => publicQuotesService.confirmVerification(token, code),
      onVerified: (access) => {
        storeDocumentGrant('quote', token, access);
        setGrant(access.grant);
        setAccessVersion((v) => v + 1);
      },
      onAccessLost: () => {
        clearDocumentGrant('quote', token);
        setGrant(null);
        setAccessVersion((v) => v + 1);
      },
    },
  }), [token, grant, accessVersion]);

  return <QuoteResponseView adapter={adapter} />;
};
