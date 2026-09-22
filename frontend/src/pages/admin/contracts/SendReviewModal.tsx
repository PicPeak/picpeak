/**
 * The review before a contract goes out (#1445). Send used to fire on one
 * click without a confirmation. This shows what the send will freeze and
 * deliver — the customer, the signers and their order, the attachments and
 * whether their files still match, the price, the template version — and
 * the problems the server found, with the PDF preview and a layout preview
 * of the signing page. The final button says what it does, and stays
 * disabled while an error stands.
 *
 * When the customer's address would print empty, the review offers to ask
 * the customer for their details first (#1446, collect-then-freeze). That
 * send invites only the first signer and renders nothing, so the review then
 * names neither a price nor a PDF: both are made once the details are in.
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, FileDown, XCircle } from 'lucide-react';
import { Button, Loading } from '../../../components/common';
import { ContractLayoutPreview } from '../../../components/contracts/ContractLayoutPreview';
import { contractsService } from '../../../services/contracts.service';
import { formatMoneyMinor } from '../../../utils/money';
import { ContractModal } from './ContractModal';

const heading = 'text-sm font-semibold text-neutral-900 dark:text-neutral-100 mb-1';

export const SendReviewModal: React.FC<{
  contractId: number;
  onClose: () => void;
  /** Called with the review's token (the server refuses the send if the
   *  contract changed since) and `collectData`: ask the customer for their
   *  details first (#1446). */
  onSend: (reviewToken: string, collectData: boolean) => void;
  onPreviewPdf: () => void;
  sending: boolean;
  /** {{customer_address}} would print empty: offer collect-then-freeze. */
  customerAddressMissing?: boolean;
}> = ({ contractId, onClose, onSend, onPreviewPdf, sending, customerAddressMissing = false }) => {
  const { t } = useTranslation();
  const [showLayout, setShowLayout] = useState(false);
  const [collectChecked, setCollectData] = useState(false);
  const collectData = customerAddressMissing && collectChecked;
  const { data: review, isLoading, isError, refetch } = useQuery({
    queryKey: ['contract-send-preview', contractId],
    queryFn: () => contractsService.sendPreview(contractId),
    staleTime: 0,
    gcTime: 0,
  });

  const errors = review ? review.problems.filter((p) => p.severity === 'error') : [];
  const warnings = review ? review.problems.filter((p) => p.severity === 'warning') : [];
  const invited = review ? review.signers.filter((s) => s.role === 'customer').length : 0;
  const money = (minor: number) => (review?.totals ? formatMoneyMinor(minor, review.totals.currency) : String(minor));
  const problemText = (p: { code: string; message: string; keys?: string[] }) => t(`contracts.detail.review.problems.${p.code}`, p.message, {
    keys: (p.keys || []).map((k) => `{{${k}}}`).join(', '),
  });

  const footer = (
    <>
      <Button variant="outline" onClick={onClose}>{t('common.cancel', 'Cancel')}</Button>
      <Button onClick={() => { if (review) onSend(review.reviewToken, collectData); }} disabled={!review || errors.length > 0 || sending}>
        {sending
          ? t('contracts.detail.review.sending', 'Sending…')
          : collectData
            ? t('contracts.detail.review.requestDetails', 'Ask for the details')
            : t('contracts.detail.review.sendTo', 'Send to {{count}} signers', { count: invited })}
      </Button>
    </>
  );

  return (
    <ContractModal
      titleId="contract-send-review-title"
      title={t('contracts.detail.review.title', 'Review before sending')}
      onClose={onClose}
      footer={footer}
      width="max-w-4xl"
    >
      {isLoading && <Loading />}
      {isError && (
        <div role="alert" className="text-sm text-red-800 dark:text-red-200">
          {t('contracts.detail.review.loadFailed', 'The review could not be loaded.')}{' '}
          <button type="button" className="underline" onClick={() => { void refetch(); }}>{t('common.retry', 'Retry')}</button>
        </div>
      )}
      {review && (
        <div className="space-y-4 text-sm">
          {review.problems.length > 0 ? (
            <section aria-labelledby="send-review-problems" role="status"
              className={`p-3 rounded-md border ${errors.length
                ? 'border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-950/30'
                : 'border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/30'}`}>
              <h3 id="send-review-problems" className={heading}>
                {errors.length
                  ? t('contracts.detail.review.blocked', 'This contract can\'t be sent yet')
                  : t('contracts.detail.review.warnings', 'Please check')}
              </h3>
              <ul className="space-y-1">
                {[...errors, ...warnings].map((p, i) => (
                  <li key={`${p.code}-${i}`} className="flex items-start gap-2">
                    {p.severity === 'error'
                      ? <XCircle className="w-4 h-4 mt-0.5 shrink-0 text-red-700 dark:text-red-400" aria-hidden="true" />
                      : <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-amber-700 dark:text-amber-400" aria-hidden="true" />}
                    <span className="sr-only">{p.severity === 'error' ? t('contracts.templates.check.error', 'Error') : t('contracts.templates.check.warning', 'Warning')}:</span>
                    <span>{problemText(p)}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : (
            <p role="status" className="flex items-center gap-2 text-green-800 dark:text-green-300">
              <CheckCircle2 className="w-4 h-4" aria-hidden="true" />
              {t('contracts.detail.review.ready', 'Everything is ready to send.')}
            </p>
          )}

          {customerAddressMissing && (
            <section className="p-3 rounded-md border border-neutral-200 dark:border-neutral-700">
              <label className="flex items-start gap-2 text-neutral-800 dark:text-neutral-200">
                <input type="checkbox" className="mt-0.5" checked={collectChecked}
                  onChange={(e) => { setCollectData(e.target.checked); setShowLayout(false); }} />
                {t('contracts.detail.collectData', 'Ask the customer to complete their details first')}
              </label>
              {collectData && (
                <p className="mt-1 text-neutral-600 dark:text-neutral-400">
                  {t('contracts.detail.review.collectHint', 'Only the first signer gets a link now, to complete their details. The contract, its PDF and the price are prepared once they have, and then go to the other signers.')}
                </p>
              )}
            </section>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <section>
              <h3 className={heading}>{t('contracts.detail.review.customer', 'Customer')}</h3>
              {review.content.recipient ? (
                <p className="text-neutral-800 dark:text-neutral-200">
                  {review.content.recipient.companyName || review.content.recipient.displayName}
                  {review.content.recipient.email && <span className="block text-neutral-600 dark:text-neutral-400">{review.content.recipient.email}</span>}
                </p>
              ) : <p>—</p>}
            </section>
            <section>
              <h3 className={heading}>{t('contracts.detail.review.signers', 'Signers')}</h3>
              <p className="text-neutral-600 dark:text-neutral-400 mb-1">
                {review.signingOrder === 'sequential'
                  ? t('contracts.detail.review.sequential', 'One after the other, in this order')
                  : t('contracts.detail.review.parallel', 'All at once')}
              </p>
              <ol className="list-decimal pl-5 space-y-0.5 text-neutral-800 dark:text-neutral-200">
                {review.signers.map((s) => (
                  <li key={`${s.role}-${s.position}`}>
                    {s.name || '—'}
                    {s.email ? ` · ${s.email}` : ''}
                    {s.role === 'issuer' && ` · ${t('contracts.detail.review.issuer', 'your countersignature')}`}
                  </li>
                ))}
              </ol>
            </section>
            <section>
              <h3 className={heading}>{t('contracts.attachments.heading', 'Attachments')}</h3>
              {review.attachments.length === 0 ? (
                <p className="text-neutral-600 dark:text-neutral-400">{t('contracts.detail.review.noAttachments', 'None')}</p>
              ) : (
                <ul className="space-y-0.5 text-neutral-800 dark:text-neutral-200">
                  {review.attachments.map((a) => (
                    <li key={a.attachmentId} className="flex flex-wrap items-center gap-2">
                      {a.ok
                        ? <CheckCircle2 className="w-3.5 h-3.5 text-green-700 dark:text-green-400" aria-hidden="true" />
                        : <XCircle className="w-3.5 h-3.5 text-red-700 dark:text-red-400" aria-hidden="true" />}
                      <span>{a.name}</span>
                      <span className="text-xs text-neutral-600 dark:text-neutral-400">
                        {a.delivery === 'merged'
                          ? t('contracts.detail.review.merged', 'in the PDF')
                          : t('contracts.detail.review.separate', 'separate file')}
                        {' · '}{t('contracts.detail.review.pages', '{{count}} pages', { count: a.pages })}
                      </span>
                      {!a.ok && <span className="text-xs text-red-700 dark:text-red-400">{t('contracts.detail.review.fileProblem', 'file problem')}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section>
              <h3 className={heading}>{t('contracts.detail.review.price', 'Price')}</h3>
              {collectData ? (
                <p className="text-neutral-600 dark:text-neutral-400">{t('contracts.detail.review.afterDetails', 'Set once the customer has completed their details.')}</p>
              ) : review.totals ? (
                <dl className="grid grid-cols-2 gap-x-3 text-neutral-800 dark:text-neutral-200">
                  <dt>{t('publicContract.price.net', 'Net')}</dt><dd className="text-right tabular-nums">{money(review.totals.netMinor)}</dd>
                  {(review.totals.vatMinor !== 0 || review.totals.vatRatePercent > 0) && (
                    <><dt>{t('publicContract.price.vat', 'VAT')} ({review.totals.vatRatePercent}%)</dt><dd className="text-right tabular-nums">{money(review.totals.vatMinor)}</dd></>
                  )}
                  <dt className="font-semibold">{t('publicContract.price.total', 'Total')}</dt>
                  <dd className="text-right tabular-nums font-semibold">{money(review.totals.grossMinor)}</dd>
                </dl>
              ) : (
                <p className="text-neutral-600 dark:text-neutral-400">{t('contracts.detail.review.noPrice', 'No quote attached — the contract names no price.')}</p>
              )}
            </section>
            <section>
              <h3 className={heading}>{t('contracts.detail.review.template', 'Template')}</h3>
              <p className="text-neutral-800 dark:text-neutral-200">
                {review.template
                  ? t('contracts.detail.review.templateVersion', '{{name}}, version {{version}}', { name: review.template.name, version: review.template.version })
                  : t('contracts.detail.review.noTemplate', 'No template')}
              </p>
            </section>
          </div>

          {!collectData && (
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={onPreviewPdf}>
                <FileDown className="w-4 h-4 mr-1" />{t('contracts.detail.previewPdf', 'Preview PDF')}
              </Button>
              <Button variant="outline" size="sm" aria-expanded={showLayout} onClick={() => setShowLayout((v) => !v)}>
                {showLayout
                  ? t('contracts.detail.review.hideLayout', 'Hide the signing page')
                  : t('contracts.detail.review.showLayout', 'Show the signing page')}
              </Button>
            </div>
          )}
          {showLayout && !collectData && <ContractLayoutPreview content={review.content} idPrefix="send-review-layout" />}
        </div>
      )}
    </ContractModal>
  );
};
