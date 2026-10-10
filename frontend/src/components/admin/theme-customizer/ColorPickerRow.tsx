import React from 'react';
import { AlertTriangle, Info, RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Input } from '../../common';

/**
 * Compact color-picker row used by the palette.
 * Renders [Label + Info icon (tooltip)] / [color swatch + hex input].
 * Help text lives on the Info icon so every row is the same height and the
 * pickers stay grid-aligned. Readability warnings show under the row;
 * hovering or focusing the row reports it, so a preview can point at
 * where the colour lands.
 */
export const ColorPickerRow: React.FC<{
  label: string;
  help: string;
  value: string;
  fallback: string;
  onChange: (value: string) => void;
  /** Shown under the row; informs, never blocks. */
  warnings?: string[];
  /** Offers "Reset" when the value differs from this. */
  defaultValue?: string;
  onReset?: () => void;
  /** Overrides when the reset shows, and what it says. */
  resetVisible?: boolean;
  resetLabel?: string;
  /** One muted line under the row, e.g. where an unset value comes from. */
  hint?: string;
  onFocusChange?: (focused: boolean) => void;
}> = ({ label, help, value, fallback, onChange, warnings = [], defaultValue, onReset, resetVisible, resetLabel, hint, onFocusChange }) => {
  const { t } = useTranslation();
  const inputId = React.useId();
  const canReset = !!onReset && (resetVisible ?? (!!defaultValue && value.toLowerCase() !== defaultValue.toLowerCase()));
  return (
    <div
      onMouseEnter={() => onFocusChange?.(true)}
      onMouseLeave={() => onFocusChange?.(false)}
      onFocus={() => onFocusChange?.(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onFocusChange?.(false);
      }}
    >
      <div className="flex items-center gap-1.5 mb-2">
        <label htmlFor={inputId} className="text-sm font-medium text-body">{label}</label>
        <span className="info-tooltip text-faint" data-tooltip={help} tabIndex={0} aria-label={help}>
          <Info className="w-3.5 h-3.5" />
        </span>
        {canReset && (
          <button
            type="button"
            onClick={onReset}
            className="ml-auto inline-flex items-center gap-1 text-xs text-muted hover:text-body"
          >
            <RotateCcw className="w-3 h-3" />
            {resetLabel || t('branding.resetColor', 'Default')}
          </button>
        )}
      </div>
      <div className="flex gap-2">
        <input
          type="color"
          value={/^#[0-9a-f]{6}$/i.test(value) ? value : fallback}
          onChange={(e) => onChange(e.target.value)}
          aria-label={label}
          className="h-10 w-20 rounded border border-line-strong cursor-pointer"
        />
        <Input
          id={inputId}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={fallback}
          className="flex-1"
        />
      </div>
      {hint && <p className="mt-1.5 text-xs text-muted">{hint}</p>}
      {warnings.map((warning) => (
        <p key={warning} className="mt-1.5 flex items-start gap-1.5 text-xs text-warning-text">
          <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-px" aria-hidden="true" />
          {warning}
        </p>
      ))}
    </div>
  );
};
