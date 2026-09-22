/**
 * "Convert to contract" (#1445): which contract template the draft starts
 * from — preselected with the one the quote's template names, else the
 * default contract template.
 */
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Button } from '../../../components/common';
import { ContractModal } from '../contracts/ContractModal';
import { contractTemplatesService } from '../../../services/contractTemplates.service';
import { quoteCatalogService } from '../../../services/quoteCatalog.service';

export const ConvertToContractDialog: React.FC<{
  sourceTemplateId: number | null | undefined;
  onClose: () => void;
  onConvert: (contractTemplateId: number | null) => void;
  converting: boolean;
}> = ({ sourceTemplateId, onClose, onConvert, converting }) => {
  const { t } = useTranslation();
  const { data: list, isLoading } = useQuery({
    queryKey: ['contract-templates'],
    queryFn: () => contractTemplatesService.list(),
    retry: false,
  });
  const { data: quoteTemplate, isFetched: quoteTemplateSettled } = useQuery({
    queryKey: ['quote-template', sourceTemplateId],
    queryFn: () => quoteCatalogService.getTemplate(sourceTemplateId as number),
    enabled: !!sourceTemplateId,
    retry: false,
  });
  const usable = (list?.templates || []).filter((tpl) => tpl.status !== 'archived' && tpl.currentVersionId);
  const [choice, setChoice] = useState<string>('');
  // A choice the admin made is never replaced by a later preselection.
  const [touched, setTouched] = useState(false);
  // Preselect only once everything that decides it is known: the list, and
  // the quote template's contract template when the quote has a template
  // (its query usually resolves after the list; preselecting earlier would
  // send the default explicitly and override the server's own fallback).
  const waitingForQuoteTemplate = !!sourceTemplateId && !quoteTemplateSettled;

  useEffect(() => {
    if (touched || choice || !usable.length || waitingForQuoteTemplate) return;
    const fromQuote = quoteTemplate?.template.defaultContractTemplateId;
    const preferred = usable.find((tpl) => tpl.id === fromQuote) || usable.find((tpl) => tpl.isDefault) || usable[0];
    setChoice(String(preferred.id));
  }, [touched, choice, usable, quoteTemplate, waitingForQuoteTemplate]);

  const fromQuoteName = usable.find((tpl) => tpl.id === quoteTemplate?.template.defaultContractTemplateId)?.name;

  return (
    <ContractModal
      titleId="convert-to-contract-title"
      title={t('quotes.convertToContract', 'Convert to contract')}
      onClose={onClose}
      width="max-w-lg"
      footer={(
        <>
          <Button variant="outline" onClick={onClose}>{t('common.cancel', 'Cancel')}</Button>
          <Button onClick={() => onConvert(choice ? Number(choice) : null)} disabled={converting || isLoading || (!choice && waitingForQuoteTemplate)}>
            {t('quotes.convertToContractConfirm', 'Draft the contract')}
          </Button>
        </>
      )}
    >
      <p className="text-sm text-neutral-700 dark:text-neutral-300 mb-3">
        {t('quotes.confirmConvertToContract',
          'Draft a contract from this quote? The customer + admin will both sign before event / invoice creation.')}
      </p>
      {usable.length > 0 && (
        <div>
          <label htmlFor="convert-contract-template" className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
            {t('quotes.contractTemplate', 'Contract template')}
          </label>
          <select id="convert-contract-template" value={choice} onChange={(e) => { setTouched(true); setChoice(e.target.value); }}
            className="w-full px-3 py-2 rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-sm text-neutral-900 dark:text-neutral-100">
            {usable.map((tpl) => (
              <option key={tpl.id} value={tpl.id}>
                {tpl.name}{tpl.isDefault ? ` — ${t('contracts.templates.default', 'Default')}` : ''}
              </option>
            ))}
          </select>
          {fromQuoteName && (
            <p className="text-xs text-neutral-600 dark:text-neutral-400 mt-1">
              {t('quotes.contractTemplateFromQuote', 'Preselected by the quote\'s template: {{name}}', { name: fromQuoteName })}
            </p>
          )}
        </div>
      )}
    </ContractModal>
  );
};
