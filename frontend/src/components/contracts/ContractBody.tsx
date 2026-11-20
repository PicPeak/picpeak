/**
 * A contract as the customer reads it (#1445): title, recipient, clauses,
 * the price and the closing text. The signing page renders it, and so do
 * the admin's pre-send review and the template editor's layout preview —
 * one component, so the previews cannot drift from what a signer sees.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { formatMoneyMinor } from '../../utils/money';
import type { ContractBlockSection, ContractBodyContent, PublicContractView } from '../../services/contracts.service';

export const SECTION_LABELS: Record<ContractBlockSection, { en: string; de: string }> = {
  basics: { en: 'Basics', de: 'Vertragsgrundlagen' },
  scope: { en: 'Scope', de: 'Leistungsumfang' },
  privacy: { en: 'Privacy', de: 'Persönlichkeitsrechte & Datenschutz' },
  commercial: { en: 'Commercial', de: 'Kaufmännisches' },
  nda: { en: 'Confidentiality', de: 'Vertraulichkeit' },
  closing: { en: 'Closing', de: 'Schlussbestimmungen' },
};

export const CONTRACT_CARD = 'bg-white dark:bg-neutral-800 rounded-xl shadow-sm border border-neutral-200 dark:border-neutral-700 p-6 md:p-8';

/** The contract as the customer reads it: title, recipient, clauses, price. */
export const ContractBody: React.FC<{ contract: ContractBodyContent }> = ({ contract: c }) => {
  const { t } = useTranslation();
  const locale = (c.language === 'de' ? 'de' : 'en') as 'en' | 'de';
  return (
    <div className={CONTRACT_CARD}>
      <div className="flex items-baseline justify-between mb-4 gap-3 flex-wrap">
        <h1 className="text-2xl font-bold">
          {c.title || t('publicContract.fallbackTitle', 'Contract')}
        </h1>
        <span className="text-xs font-mono px-2 py-1 rounded bg-neutral-100 dark:bg-neutral-700 text-neutral-600 dark:text-neutral-300">
          {c.contractNumber}
        </span>
      </div>

      {c.recipient && (
        <div className="mb-4 text-sm text-neutral-700 dark:text-neutral-300">
          <p className="font-medium">{c.recipient.companyName || c.recipient.displayName}</p>
          {/* Blank for a signer who is not the account holder (#1446): the
              address their co-signer verifies with is not theirs to see. */}
          {c.recipient.email && <p className="text-neutral-500 dark:text-neutral-400">{c.recipient.email}</p>}
        </div>
      )}

      {c.introText && (
        <p className="whitespace-pre-line text-neutral-700 dark:text-neutral-300 my-4">{c.introText}</p>
      )}

      {c.sections.map((sec) => (
        <section key={sec.section} className="mt-6">
          <h2 className="text-lg font-semibold border-b border-neutral-200 dark:border-neutral-700 pb-1 mb-3">
            {SECTION_LABELS[sec.section]?.[locale] || sec.section}
          </h2>
          {sec.blocks.map((blk) => (
            <article key={`${blk.blockId ?? 'text'}-${blk.position}`} className="mb-4">
              <h3 className="font-semibold text-sm mb-1">{blk.name}</h3>
              <p className="text-sm whitespace-pre-line leading-6 text-neutral-700 dark:text-neutral-300">{blk.body}</p>
            </article>
          ))}
        </section>
      ))}

      {/* What the contract costs (#1445). The PDF has printed the line
          table and the totals all along; the page a signer reads before
          signing showed neither, so "what you see is what you sign"
          stopped short of the price. These are the frozen figures — the
          ones covered by the hash the signature is bound to. */}
      <ContractPrice commercial={c.commercial} />

      {c.outroText && (
        <p className="whitespace-pre-line text-neutral-700 dark:text-neutral-300 mt-6">{c.outroText}</p>
      )}
    </div>
  );
};

const ContractPrice: React.FC<{ commercial: PublicContractView['commercial'] }> = ({ commercial }) => {
  const { t } = useTranslation();
  // The totals stand on their own: a quote with no counted line (every
  // add-on left unselected, say) still names a sum. Only the line table
  // depends on there being lines.
  if (!commercial) return null;
  const { currency, totals } = commercial;
  const money = (minor: number) => formatMoneyMinor(minor, currency);
  return (
    <section className="mt-6">
      <h2 className="text-lg font-semibold border-b border-neutral-200 dark:border-neutral-700 pb-1 mb-3">
        {t('publicContract.price.title', 'Services and price')}
      </h2>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          {commercial.lineItems.length > 0 && (
            <>
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
                  <th scope="col" className="py-1 pr-3 font-medium">{t('publicContract.price.description', 'Description')}</th>
                  <th scope="col" className="py-1 pr-3 font-medium text-right">{t('publicContract.price.quantity', 'Qty')}</th>
                  <th scope="col" className="py-1 font-medium text-right">{t('publicContract.price.amount', 'Amount')}</th>
                </tr>
              </thead>
              <tbody className="text-neutral-700 dark:text-neutral-300">
                {commercial.lineItems.map((li) => (
                  <tr key={`${li.position}-${li.parentPosition ?? 'top'}`} className="border-t border-neutral-100 dark:border-neutral-800">
                    <td className={`py-1.5 pr-3 ${li.parentPosition != null ? 'pl-4 text-neutral-600 dark:text-neutral-400' : ''}`}>
                      {li.description}
                      {li.details && (
                        <span className="block text-xs text-neutral-500 dark:text-neutral-400 whitespace-pre-line">{li.details}</span>
                      )}
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums whitespace-nowrap">
                      {li.quantity}{li.unit ? ` ${t(`publicContract.price.unit.${li.unit}`, li.unit)}` : ''}
                    </td>
                    <td className="py-1.5 text-right tabular-nums whitespace-nowrap">{money(li.lineTotalMinor)}</td>
                  </tr>
                ))}
              </tbody>
            </>
          )}
          <tfoot className="border-t-2 border-neutral-300 dark:border-neutral-600">
            <tr>
              <td colSpan={2} className="py-1.5 pr-3 text-right">{t('publicContract.price.net', 'Net')}</td>
              <td className="py-1.5 text-right tabular-nums whitespace-nowrap">{money(totals.netMinor)}</td>
            </tr>
            {totals.shippingMinor > 0 && (
              <tr>
                <td colSpan={2} className="py-1.5 pr-3 text-right">{t('publicContract.price.shipping', 'Shipping')}</td>
                <td className="py-1.5 text-right tabular-nums whitespace-nowrap">{money(totals.shippingMinor)}</td>
              </tr>
            )}
            {(totals.vatMinor !== 0 || totals.vatRatePercent > 0) && (
              <tr>
                <td colSpan={2} className="py-1.5 pr-3 text-right">
                  {t('publicContract.price.vat', 'VAT')} ({totals.vatRatePercent}%)
                </td>
                <td className="py-1.5 text-right tabular-nums whitespace-nowrap">{money(totals.vatMinor)}</td>
              </tr>
            )}
            <tr className="font-semibold text-neutral-900 dark:text-neutral-100">
              <td colSpan={2} className="py-1.5 pr-3 text-right">{t('publicContract.price.total', 'Total')}</td>
              <td className="py-1.5 text-right tabular-nums whitespace-nowrap">{money(totals.grossMinor)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      {commercial.sourceQuoteNumber && (
        <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-2">
          {t('publicContract.price.fromQuote', 'From quote {{number}}', { number: commercial.sourceQuoteNumber })}
        </p>
      )}
    </section>
  );
};
