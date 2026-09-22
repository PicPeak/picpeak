/**
 * The declarations a signer confirms (#1446), edited on a template.
 *
 * Each has a key, whether it is required, and its wording in English and
 * German. The server numbers the versions: unchanged wording keeps its
 * version, changed wording (or a change to "required") counts it up when
 * the draft is saved. Publishing freezes them with the version, and a
 * contract sent from it carries them in the content its signature is bound
 * to. The signer sees every declaration unticked.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { Card } from '../../../components/common';
import type { ContractConsentDefinition } from '../../../services/contractTemplates.service';

const MAX_CONSENTS = 8;
const MAX_TEXT = 1000;

const fieldClass = 'focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-neutral-900 w-full px-3 py-2 rounded-md border border-neutral-300 dark:border-neutral-600 '
  + 'bg-white dark:bg-neutral-800 text-sm text-neutral-900 dark:text-neutral-100';
const labelClass = 'block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1';
const iconButton = 'focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-neutral-900 p-1 rounded border border-neutral-300 dark:border-neutral-600 text-neutral-700 dark:text-neutral-200 '
  + 'disabled:opacity-40 hover:bg-neutral-50 dark:hover:bg-neutral-700';

/** The next free `declaration_<n>` key. */
function suggestKey(existing: ContractConsentDefinition[]): string {
  let n = existing.length + 1;
  const taken = new Set(existing.map((c) => c.key));
  while (taken.has(`declaration_${n}`)) n += 1;
  return `declaration_${n}`;
}

export const TemplateConsentsEditor: React.FC<{
  value: ContractConsentDefinition[];
  /** `coalesce` folds a run of keystrokes in one field into one undo step. */
  onChange: (next: ContractConsentDefinition[], coalesce?: string) => void;
  readOnly?: boolean;
}> = ({ value, onChange, readOnly = false }) => {
  const { t } = useTranslation();
  const update = (index: number, patch: Partial<ContractConsentDefinition>, coalesce?: string) => onChange(
    value.map((c, i) => (i === index ? { ...c, ...patch } : c)),
    coalesce,
  );
  const move = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= value.length) return;
    const next = [...value];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };

  return (
    <Card padding="lg" className="space-y-3">
      <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
        {t('contracts.templates.consents.title', 'Declarations the signer confirms')}
      </h2>
      <p className="text-sm text-neutral-600 dark:text-neutral-400">
        {t('contracts.templates.consents.help', 'Each one is a separate checkbox on the signing page, never pre-ticked. Required ones must be ticked to sign. The wording is part of what is signed: changing it gives the declaration a new version when the draft is saved, and contracts already sent keep the wording they went out with.')}
      </p>
      {value.length === 0 && (
        <p className="text-sm text-red-700 dark:text-red-400">
          {t('contracts.templates.consents.none', 'Add at least one required declaration before publishing.')}
        </p>
      )}
      <ol className="space-y-3">
        {value.map((consent, index) => {
          const id = `contract-template-consent-${index}`;
          return (
            <li key={index} className="rounded border border-neutral-200 dark:border-neutral-700 p-3 space-y-2">
              <div className="flex items-end gap-2 flex-wrap">
                <div className="flex-1 min-w-[180px]">
                  <label htmlFor={`${id}-key`} className={labelClass}>{t('contracts.templates.consents.key', 'Key')}</label>
                  <input
                    id={`${id}-key`}
                    className={`${fieldClass} font-mono`}
                    value={consent.key}
                    maxLength={40}
                    readOnly={readOnly}
                    onChange={(e) => update(index, { key: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') }, `consent:${index}:key`)}
                  />
                </div>
                <label className="flex items-center gap-2 text-sm text-neutral-800 dark:text-neutral-200 pb-2">
                  <input
                    type="checkbox"
                    checked={consent.required}
                    disabled={readOnly}
                    onChange={(e) => update(index, { required: e.target.checked })}
                  />
                  {t('contracts.templates.consents.required', 'Required to sign')}
                </label>
                {consent.version != null && (
                  <span className="text-xs text-neutral-500 dark:text-neutral-400 pb-2">
                    {t('contracts.templates.consents.version', 'Version {{version}}', { version: consent.version })}
                  </span>
                )}
                <div className="flex items-center gap-1 pb-1.5">
                  <button type="button" className={iconButton} disabled={readOnly || index === 0} onClick={() => move(index, -1)}
                    aria-label={t('contracts.templates.moveUp', 'Move up') as string}><ArrowUp className="w-3.5 h-3.5" /></button>
                  <button type="button" className={iconButton} disabled={readOnly || index === value.length - 1} onClick={() => move(index, 1)}
                    aria-label={t('contracts.templates.moveDown', 'Move down') as string}><ArrowDown className="w-3.5 h-3.5" /></button>
                  {!readOnly && (
                    <button type="button" className={iconButton} onClick={() => onChange(value.filter((_, i) => i !== index))}
                      aria-label={t('contracts.templates.consents.remove', 'Remove declaration {{number}}', { number: index + 1 }) as string}>
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {(['de', 'en'] as const).map((locale) => (
                  <div key={locale}>
                    <label htmlFor={`${id}-${locale}`} className={labelClass}>
                      {locale === 'de'
                        ? t('contracts.templates.consents.textDe', 'Wording (German)')
                        : t('contracts.templates.consents.textEn', 'Wording (English)')}
                    </label>
                    <textarea
                      id={`${id}-${locale}`}
                      rows={2}
                      maxLength={MAX_TEXT}
                      className={fieldClass}
                      value={consent.text[locale] || ''}
                      readOnly={readOnly}
                      onChange={(e) => update(index, { text: { ...consent.text, [locale]: e.target.value } }, `consent:${index}:${locale}`)}
                    />
                  </div>
                ))}
              </div>
            </li>
          );
        })}
      </ol>
      {!readOnly && value.length < MAX_CONSENTS && (
        <button
          type="button"
          className="inline-flex items-center gap-1 text-sm px-3 py-1.5 rounded-md border border-neutral-300 dark:border-neutral-600 text-neutral-700 dark:text-neutral-200"
          onClick={() => onChange([...value, { key: suggestKey(value), required: false, text: {} }])}
        >
          <Plus className="w-4 h-4" />
          {t('contracts.templates.consents.add', 'Add declaration')}
        </button>
      )}
    </Card>
  );
};
