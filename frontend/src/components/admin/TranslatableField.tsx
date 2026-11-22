/**
 * A gallery text with one tab per language (issue 2550). The first tab is the
 * stored field itself, the gallery's default text (in its primary language);
 * every other tab is a hand-written translation. Without languages it renders
 * the plain field, so a gallery with the mode off sees no change.
 */
import React, { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SUPPORTED_LANGUAGES } from '../common/LanguageSelector';
import type { TextLanguageMode } from '../../types';

export const TEXT_LANGUAGES = SUPPORTED_LANGUAGES.map((language) => language.code);

export const languageName = (code: string | null | undefined): string =>
  SUPPORTED_LANGUAGES.find((language) => language.code === code)?.name ?? (code || '');

/**
 * The translation tabs a gallery offers after its default tab: in bilingual
 * mode the secondary language, in visitor mode every other UI language.
 * Empty while the mode is off.
 */
export function translationLanguages(mode: TextLanguageMode | undefined, primary: string | null | undefined, secondary: string | null | undefined): string[] {
  if (mode === 'bilingual') return secondary && secondary !== primary ? [secondary] : [];
  if (mode === 'visitor') return TEXT_LANGUAGES.filter((code) => code !== primary);
  return [];
}

export interface TranslatableFieldProps {
  id: string;
  label?: React.ReactNode;
  /** The gallery's primary language: the default tab's label. Null labels it "Default". */
  primary: string | null | undefined;
  /** The other languages, one tab each. Empty renders the plain field. */
  languages: string[];
  value: string;
  /** Omitted: the default tab is shown read-only, with `defaultHint` below it. */
  onChange?: (value: string) => void;
  defaultHint?: React.ReactNode;
  translations: Partial<Record<string, string>>;
  onTranslationChange: (language: string, text: string) => void;
  multiline?: boolean;
  rows?: number;
  maxLength?: number;
  placeholder?: string;
  inputClassName: string;
  labelClassName?: string;
  disabled?: boolean;
}

export const TranslatableField: React.FC<TranslatableFieldProps> = ({
  id, label, primary, languages, value, onChange, defaultHint, translations, onTranslationChange,
  multiline = false, rows = 3, maxLength, placeholder, inputClassName, labelClassName, disabled,
}) => {
  const { t } = useTranslation();
  const [active, setActive] = useState<string | null>(null);
  // A tab that the mode no longer offers falls back to the default one.
  const current = active !== null && languages.includes(active) ? active : null;
  const onDefault = current === null;
  const text = onDefault ? value : translations[current] ?? '';
  const readOnly = onDefault && !onChange;

  const input = multiline ? (
    <textarea
      id={id}
      value={text}
      onChange={(e) => (onDefault ? onChange?.(e.target.value) : onTranslationChange(current, e.target.value))}
      className={inputClassName}
      rows={rows}
      maxLength={maxLength}
      placeholder={onDefault ? placeholder : value || placeholder}
      readOnly={readOnly}
      disabled={disabled}
      lang={onDefault ? primary || undefined : current}
    />
  ) : (
    <input
      id={id}
      type="text"
      value={text}
      onChange={(e) => (onDefault ? onChange?.(e.target.value) : onTranslationChange(current, e.target.value))}
      className={inputClassName}
      maxLength={maxLength}
      placeholder={onDefault ? placeholder : value || placeholder}
      readOnly={readOnly}
      disabled={disabled}
      lang={onDefault ? primary || undefined : current}
    />
  );

  if (languages.length === 0) {
    return (
      <div>
        {label && <label className={labelClassName} htmlFor={id}>{label}</label>}
        {input}
        {readOnly && defaultHint && <p className="mt-1 text-xs text-muted">{defaultHint}</p>}
      </div>
    );
  }

  return (
    <div>
      {label && <label className={labelClassName} htmlFor={id}>{label}</label>}
      <LanguageTabs
        primary={primary}
        languages={languages}
        active={current}
        onChange={setActive}
        filled={(code) => (code === null ? value.trim() !== '' : (translations[code] ?? '').trim() !== '')}
        controls={id}
      />
      {input}
      {readOnly && defaultHint && <p className="mt-1 text-xs text-muted">{defaultHint}</p>}
      {!onDefault && (
        <p className="mt-1 text-xs text-muted">
          {t('events.languages.translationHint', 'The {{language}} text, written by hand. Leave it empty if there is none.', { language: languageName(current) })}
        </p>
      )}
    </div>
  );
};

export interface LanguageTabsProps {
  primary: string | null | undefined;
  languages: string[];
  /** null = the default tab. */
  active: string | null;
  onChange: (language: string | null) => void;
  filled: (language: string | null) => boolean;
  /** The id of the field the tabs switch. */
  controls?: string;
}

/** The language tab row: the default text first, then one tab per translation. */
export const LanguageTabs: React.FC<LanguageTabsProps> = ({ primary, languages, active, onChange, filled, controls }) => {
  const { t } = useTranslation();
  const tabsId = useId();
  const tab = (code: string | null) => {
    const selected = active === code;
    const hasText = filled(code);
    const name = code === null
      ? (primary ? languageName(primary) : t('events.languages.defaultText', 'Default'))
      : languageName(code);
    return (
      <button
        key={code ?? 'default'}
        type="button"
        role="tab"
        id={`${tabsId}-${code ?? 'default'}`}
        aria-selected={selected}
        aria-controls={controls}
        title={name}
        onClick={() => onChange(code)}
        className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs -mb-px border-b-2 ${
          selected ? 'border-accent text-heading font-medium' : 'border-transparent text-soft hover:text-heading'
        }`}
      >
        <span className="uppercase tracking-wide">{code ?? primary ?? t('events.languages.defaultShort', 'Default')}</span>
        {/* Filled or empty: the dot says it, the label says which. */}
        <span
          className={`w-1.5 h-1.5 rounded-full ${hasText ? 'bg-success' : 'bg-fill-strong'}`}
          role="img"
          aria-label={hasText ? t('events.languages.filled', 'has text') : t('events.languages.empty', 'no text yet')}
        />
      </button>
    );
  };
  return (
    <div role="tablist" aria-label={t('events.languages.tabsLabel', 'Language')} className="flex flex-wrap gap-0.5 border-b border-line mb-2">
      {tab(null)}
      {languages.map(tab)}
    </div>
  );
};
