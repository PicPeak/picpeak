/**
 * The text fields of the contract template editor (#1445): a text per
 * language with the placeholder picker, and the "Show only if…" rule of a
 * clause.
 */
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CONTRACT_LOCALES, type ContractLocale, type LocaleText } from '../../../services/contractTemplates.service';
import { PlaceholderPicker, placeholderLang, useContractPlaceholders } from './PlaceholderPicker';
import { applyCondition, readCondition, unwrapCondition, type ClauseCondition } from './clauseCondition';

export const fieldClass = 'focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-neutral-900 w-full px-3 py-2 rounded-md border border-neutral-300 dark:border-neutral-600 '
  + 'bg-white dark:bg-neutral-800 text-sm text-neutral-900 dark:text-neutral-100';
export const labelClass = 'block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1';
export const iconButton = 'focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-neutral-900 p-1 rounded border border-neutral-300 dark:border-neutral-600 text-neutral-700 dark:text-neutral-200 '
  + 'disabled:opacity-40 hover:bg-neutral-50 dark:hover:bg-neutral-700';

/** A text per language, with a tab per language. */
export const LocaleTextField: React.FC<{
  id: string;
  label: string;
  value: LocaleText;
  /** The new texts, and the language that changed (for undo coalescing). */
  onChange: (value: LocaleText, locale: ContractLocale) => void;
  hint?: LocaleText;
  rows?: number;
  readOnly?: boolean;
  /** Switch to a language and focus the text (a check finding's "Go to"). */
  focusRequest?: { locale: ContractLocale; nonce: number } | null;
}> = ({ id, label, value, onChange, hint, rows = 3, readOnly = false, focusRequest = null }) => {
  const { t } = useTranslation();
  const [locale, setLocale] = useState<ContractLocale>('de');
  const textarea = useRef<HTMLTextAreaElement>(null);
  const pendingFocus = useRef(false);
  useEffect(() => {
    if (!focusRequest) return;
    pendingFocus.current = true;
    setLocale(focusRequest.locale);
  }, [focusRequest]);
  useEffect(() => {
    if (!pendingFocus.current || !textarea.current) return;
    pendingFocus.current = false;
    textarea.current.scrollIntoView?.({ block: 'center' });
    textarea.current.focus();
  }, [focusRequest, locale]);
  return (
    <div>
      <div className="flex items-center justify-between gap-2 flex-wrap mb-1">
        <label htmlFor={`${id}-${locale}`} className="text-sm font-medium text-neutral-700 dark:text-neutral-300">{label}</label>
        <div className="flex gap-1 items-center flex-wrap" role="group" aria-label={t('contracts.templates.languages', 'Languages') as string}>
          {!readOnly && (
            <PlaceholderPicker target={textarea} onInsert={(next) => onChange({ ...value, [locale]: next }, locale)} />
          )}
          {CONTRACT_LOCALES.map((l) => (
            <button
              key={l}
              type="button"
              aria-pressed={locale === l}
              onClick={() => setLocale(l)}
              className={`px-2 py-0.5 rounded text-xs border ${locale === l
                ? 'bg-primary-600 text-white border-primary-600'
                : 'border-neutral-300 dark:border-neutral-600 text-neutral-700 dark:text-neutral-300'}`}
            >
              {l.toUpperCase()}{value[l] ? ' •' : ''}
            </button>
          ))}
        </div>
      </div>
      <textarea
        ref={textarea}
        id={`${id}-${locale}`}
        rows={rows}
        className={fieldClass}
        value={value[locale] || ''}
        readOnly={readOnly}
        placeholder={hint?.[locale] || hint?.en || hint?.de || ''}
        onChange={(e) => onChange({ ...value, [locale]: e.target.value }, locale)}
      />
    </div>
  );
};

/**
 * "Show only if…": one placeholder that may be empty, and whether the clause
 * shows when it is filled in or when it is empty. Writes the clause body
 * wrapped in `{{#if}}` / `{{#unless}}` (clauseCondition.ts).
 */
export const ClauseConditionField: React.FC<{
  id: string;
  body: LocaleText;
  /** A block's library text, which the rule wraps when the clause has no text of its own. */
  baseText: LocaleText;
  readOnly: boolean;
  onChange: (body: LocaleText) => void;
}> = ({ id, body, baseText, readOnly, onChange }) => {
  const { t, i18n } = useTranslation();
  const lang = placeholderLang(i18n.language);
  const options = useContractPlaceholders().filter((p) => p.conditional);
  const hasOwnText = Object.values(body).some((text) => typeof text === 'string' && text.trim() !== '');
  const current = readCondition(hasOwnText ? body : {});
  const set = (next: ClauseCondition | null) => {
    const source = hasOwnText ? body : baseText;
    const written = applyCondition(source, next);
    // Rule removed from a block whose text is the library's: back to the library text.
    const plain = unwrapCondition(written);
    const isLibrary = !next && Object.keys(baseText).length > 0
      && Object.keys(plain).length === Object.keys(baseText).length
      && Object.entries(baseText).every(([locale, text]) => plain[locale as ContractLocale] === text);
    onChange(isLibrary ? {} : written);
  };
  const key = current && current !== 'mixed' ? current.key : '';
  const kind = current && current !== 'mixed' ? current.kind : 'if';
  return (
    <div className="flex flex-wrap items-end gap-2">
      <div>
        <label htmlFor={`${id}-key`} className={labelClass}>{t('contracts.templates.condition.label', 'Show only if…')}</label>
        <select id={`${id}-key`} className={fieldClass} value={key} disabled={readOnly}
          onChange={(e) => set(e.target.value ? { kind, key: e.target.value } : null)}>
          <option value="">{t('contracts.templates.condition.always', 'Always show')}</option>
          {options.map((p) => <option key={p.key} value={p.key}>{p.label[lang]}</option>)}
        </select>
      </div>
      {key && (
        <div>
          <label htmlFor={`${id}-kind`} className="sr-only">{t('contracts.templates.condition.kind', 'Condition')}</label>
          <select id={`${id}-kind`} className={fieldClass} value={kind} disabled={readOnly}
            onChange={(e) => set({ kind: e.target.value as ClauseCondition['kind'], key })}>
            <option value="if">{t('contracts.templates.condition.filled', 'is filled in')}</option>
            <option value="unless">{t('contracts.templates.condition.empty', 'is empty')}</option>
          </select>
        </div>
      )}
      {current === 'mixed' && (
        <p className="text-xs text-amber-800 dark:text-amber-300 basis-full">
          {t('contracts.templates.condition.mixed', 'This text has conditions of its own. Choosing a rule here replaces the one around the whole clause.')}
        </p>
      )}
    </div>
  );
};
