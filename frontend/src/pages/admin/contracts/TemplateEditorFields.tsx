/**
 * The text fields of the contract template editor (#1445): a text per
 * language with the placeholder picker, and the "Show only if…" rule of a
 * clause.
 */
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CONTRACT_LOCALES, type ContractLocale, type LocaleText } from '../../../services/contractTemplates.service';
import { PlaceholderPicker, placeholderLang, useContractPlaceholders } from './PlaceholderPicker';
import { applyCondition, readCondition, type ClauseCondition } from './clauseCondition';

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
  // Keyed on the nonce: the parent builds a new request object on every
  // render, and each request must move the focus once, not on every keystroke.
  const requestNonce = focusRequest?.nonce;
  const requestLocale = focusRequest?.locale;
  useEffect(() => {
    if (requestNonce === undefined || !requestLocale) return;
    pendingFocus.current = true;
    setLocale(requestLocale);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestNonce]);
  useEffect(() => {
    if (!pendingFocus.current || !textarea.current) return;
    pendingFocus.current = false;
    textarea.current.scrollIntoView?.({ block: 'center' });
    textarea.current.focus();
  }, [requestNonce, locale]);
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
  // What the clause says per language: its own text where it has one, the
  // library's elsewhere — the backend merges them the same way, so a rule
  // must wrap every language, inherited ones included.
  const own = Object.fromEntries(Object.entries(body)
    .filter(([, text]) => typeof text === 'string' && text.trim() !== '')) as LocaleText;
  const effective: LocaleText = { ...baseText, ...own };
  // Read from what renders: a library text can carry a rule of its own.
  const current = readCondition(effective);
  const set = (next: ClauseCondition | null) => {
    const written = applyCondition(effective, next);
    // Only what differs from the library is the clause's own text; a rule
    // removed from library text leaves nothing of its own.
    const kept = Object.fromEntries(Object.entries(written)
      .filter(([locale, text]) => text !== baseText[locale as ContractLocale])) as LocaleText;
    onChange(kept);
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
