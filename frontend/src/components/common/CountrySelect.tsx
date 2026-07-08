import React from 'react';
import { clsx } from 'clsx';
import { useTranslation } from 'react-i18next';
import { countryLabel, sortedCountryOptions } from '../../constants/countries';

/**
 * Country picker whose option labels are localized country names but
 * whose stored/emitted value is always the ISO 3166-1 alpha-2 code.
 * Labels come from `Intl.DisplayNames` in the active UI language, so the
 * list stays locale-aware without a hand-maintained translation map.
 *
 * A value that isn't in the curated list (e.g. legacy data) is preserved
 * as its own option so editing an existing record never silently drops it.
 */
interface CountrySelectProps {
  label?: string;
  value: string;
  onChange: (code: string) => void;
  error?: string;
  disabled?: boolean;
  /** Label for the empty option; defaults to a translated placeholder. */
  placeholder?: string;
}

export const CountrySelect: React.FC<CountrySelectProps> = ({
  label,
  value,
  onChange,
  error,
  disabled,
  placeholder,
}) => {
  const { i18n, t } = useTranslation();
  const lang = i18n.language || 'en';
  const selectId = React.useId();

  const options = sortedCountryOptions(lang);
  const current = (value || '').trim().toUpperCase();
  const hasCurrent = options.some((o) => o.code === current);

  return (
    <div className="w-full">
      {label && (
        <label
          htmlFor={selectId}
          className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1.5"
        >
          {label}
        </label>
      )}
      <select
        id={selectId}
        value={current}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className={clsx('input', error && 'border-red-500 focus-visible:ring-red-500')}
        aria-invalid={error ? 'true' : 'false'}
        aria-describedby={error ? `${selectId}-error` : undefined}
      >
        <option value="">{placeholder ?? t('common.selectCountry', 'Select country…')}</option>
        {!hasCurrent && current && (
          <option value={current}>{countryLabel(current, lang)}</option>
        )}
        {options.map((o) => (
          <option key={o.code} value={o.code}>
            {o.label}
          </option>
        ))}
      </select>
      {error && (
        <p id={`${selectId}-error`} className="mt-1.5 text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  );
};
