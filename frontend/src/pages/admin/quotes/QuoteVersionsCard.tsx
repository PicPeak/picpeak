/**
 * "Stored versions" on the quote detail page: every PDF this quote went out as
 * (each send, each accepted copy), newest first. Editing a sent quote
 * overwrites its lines in place, so these files are the only record of what
 * an earlier send offered. Each row shows the total and lines stored with
 * it and opens the file exactly as it was sent. Hidden until the quote has
 * been sent once.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { Eye } from 'lucide-react';
import { Badge, Button, Card } from '../../../components/common';
import { quotesService, type QuoteStoredVersion } from '../../../services/quotes.service';
import { decodeBlobErrorBody } from '../../../utils/documentAccess';
import { formatMoneyMinor } from '../../../utils/money';
import { useLocalizedDate } from '../../../hooks/useLocalizedDate';

export const QuoteVersionsCard: React.FC<{ quoteId: number; currency: string }> = ({ quoteId, currency }) => {
  const { t } = useTranslation();
  const { formatDateTime: fmtDateTime } = useLocalizedDate();
  // Under the quote's own key, so every action that refreshes the quote
  // (send, add-on change, reissue) refreshes this list too.
  const { data } = useQuery({
    queryKey: ['quote', String(quoteId), 'documents'],
    queryFn: () => quotesService.documents(quoteId),
  });
  const versions = data?.documents || [];
  if (versions.length === 0) return null;

  const open = async (version: QuoteStoredVersion) => {
    const win = window.open('about:blank', '_blank');
    if (!win) {
      toast.error(t('quotes.errors.popupBlocked', 'Allow pop-ups for this site to preview the PDF.'));
      return;
    }
    try {
      win.location.href = await quotesService.documentPdfUrl(quoteId, version.id);
    } catch (err: any) {
      win.close();
      // A blob request gets its JSON error body as a Blob too.
      await decodeBlobErrorBody(err);
      toast.error(err?.response?.data?.code === 'DOCUMENT_FILE_MISSING'
        ? t('quotes.versions.fileMissing', 'This PDF is no longer on the server.')
        : (err?.response?.data?.error || err.message));
    }
  };

  return (
    <Card>
      <h3 className="font-semibold mb-1 text-heading">{t('quotes.versions.title', 'Stored versions')}</h3>
      <p className="text-xs text-muted mb-3">
        {t('quotes.versions.hint', 'Each stored version of this quote, as its PDF was saved.')}
      </p>
      <ul className="divide-y divide-line-faint">
        {versions.map((v, index) => {
          const summary = v.summary;
          const lines = (summary?.lines || []).filter((l) => !l.notIncluded);
          return (
            <li key={v.id} className="py-2 first:pt-0 last:pb-0">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge tone={v.kind === 'accepted' ? 'success' : 'neutral'}>
                      {v.kind === 'accepted'
                        ? t('quotes.versions.kind.accepted', 'Accepted')
                        : t('quotes.versions.kind.sent', 'Sent')}
                    </Badge>
                    {index === 0 && (
                      <span className="text-xs text-muted">{t('quotes.versions.latest', 'latest')}</span>
                    )}
                  </div>
                  <div className="text-sm text-body mt-1">{fmtDateTime(v.generatedAt)}</div>
                </div>
                <div className="text-right shrink-0">
                  {summary && (
                    <div className="text-sm font-semibold tabular-nums">
                      {formatMoneyMinor(summary.totalAmountMinor, summary.currency || currency)}
                    </div>
                  )}
                  <Button variant="ghost" size="sm" leftIcon={<Eye className="w-4 h-4" />} onClick={() => { void open(v); }}>
                    {t('quotes.versions.open', 'Open PDF')}
                  </Button>
                </div>
              </div>
              {lines.length > 0 && (
                <ul className="mt-1 text-xs text-muted space-y-0.5">
                  {lines.map((l, i) => {
                    // A heading or note row carries no amount: show its text only,
                    // not "1 · Heading  CHF 0.00".
                    const textOnly = l.lineKind !== 'discount' && !l.lineTotalMinor;
                    return (
                      <li key={i} className="flex justify-between gap-3">
                        <span className="flex min-w-0 gap-1">
                          <span className="truncate" title={l.description}>
                            {l.lineKind === 'discount' || textOnly ? '' : `${l.quantity}${l.unit ? ` ${t(`crm.lineItems.unitShort.${l.unit}`, l.unit)}` : ''} · `}
                            {l.description}
                          </span>
                          {/* Outside the truncated text, so a long description never hides it. */}
                          {l.isOptional && <span className="shrink-0">{t('quotes.versions.addOn', '(add-on)')}</span>}
                        </span>
                        {!textOnly && (
                          <span className="tabular-nums shrink-0">{formatMoneyMinor(l.lineTotalMinor, summary?.currency || currency)}</span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
};
