/**
 * The inputs for a service's pricing factors (#2440): a number field, a
 * yes/no switch, an option list or a travel zone (pick a zone, or type a
 * postcode). Shared by the quote editor's factor dialog and the public
 * booking request, so both ask the same questions.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { DecimalInput } from '../../components/common/DecimalInput';
import type { FactorValue, PricingFactor } from '../../services/quoteCatalog.service';

// Admin pages use the admin tokens; the public booking page the gallery
// theme (branding colours, light/dark from the public settings).
const STYLES = {
  admin: {
    input: 'w-full px-3 py-2 rounded-md border border-line-strong bg-panel text-heading text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 dark:focus-visible:ring-offset-neutral-900',
    label: 'block text-sm font-medium text-body mb-1',
    check: 'flex items-center gap-2 text-sm text-body',
    muted: 'mt-1 text-xs text-muted',
  },
  public: {
    input: 'input-themed w-full',
    label: 'block text-sm font-medium mb-1',
    check: 'flex items-center gap-2 text-sm',
    muted: 'mt-1 text-xs text-muted-theme',
  },
};

/** The value a factor starts with: its default, else nothing chosen. */
export function initialFactorValue(f: PricingFactor): FactorValue {
  const d = f.defaultValue;
  switch (f.inputType) {
    case 'number': return d != null && d !== '' ? Number(d) : f.minValue ?? f.includedUnits ?? null;
    case 'toggle': return d === 'true';
    case 'choice': return d ? Number(d) : null;
    case 'zone': return d ? { optionId: Number(d) } : null;
    default: return null;
  }
}

interface Props {
  factors: PricingFactor[];
  values: Record<string, FactorValue>;
  onChange: (values: Record<string, FactorValue>) => void;
  /** Zone factors: the admin may pick the zone; a client types a postcode. */
  zoneMode?: 'pick' | 'postcode';
  /** Zone factors whose postcode matched no zone. */
  unmatched?: number[];
  idPrefix?: string;
  variant?: 'admin' | 'public';
}

export const FactorInputs: React.FC<Props> = ({
  factors, values, onChange, zoneMode = 'pick', unmatched = [], idPrefix = 'factor', variant = 'admin',
}) => {
  const { t } = useTranslation();
  const css = STYLES[variant];
  const inputCls = css.input;
  const selectCls = `${css.input} h-10`;
  const labelCls = css.label;
  const set = (id: number, value: FactorValue) => onChange({ ...values, [id]: value });

  return (
    <div className="space-y-3">
      {factors.map((f) => {
        const id = `${idPrefix}-${f.id}`;
        const value = values[f.id];
        const hint = f.description ? <p className={css.muted}>{f.description}</p> : null;

        if (f.inputType === 'toggle') {
          return (
            <div key={f.id}>
              <label htmlFor={id} className={css.check}>
                <input id={id} type="checkbox" checked={value === true} onChange={(e) => set(f.id, e.target.checked)} />
                {f.name}
              </label>
              {hint}
            </div>
          );
        }

        if (f.inputType === 'number') {
          return (
            <div key={f.id}>
              <label htmlFor={id} className={labelCls}>
                {f.name}{f.unitLabel ? ` (${f.unitLabel})` : ''}
              </label>
              <DecimalInput id={id} className={inputCls} value={typeof value === 'number' ? value : NaN}
                min={f.minValue ?? undefined} max={f.maxValue ?? undefined}
                onChange={(n) => set(f.id, Number.isFinite(n) ? n : null)} />
              {(f.minValue != null || f.maxValue != null) && (
                <p className={css.muted}>
                  {f.minValue != null && f.maxValue != null
                    ? t('quotes.factors.range', '{{min}} to {{max}}', { min: f.minValue, max: f.maxValue })
                    : f.minValue != null
                      ? t('quotes.factors.atLeast', 'At least {{min}}', { min: f.minValue })
                      : t('quotes.factors.atMost', 'At most {{max}}', { max: f.maxValue })}
                </p>
              )}
              {hint}
            </div>
          );
        }

        if (f.inputType === 'zone' && zoneMode === 'postcode') {
          const postcode = value && typeof value === 'object' ? value.postcode || '' : '';
          return (
            <div key={f.id}>
              <label htmlFor={id} className={labelCls}>
                {t('quotes.factors.postcodeFor', '{{name}}: postcode', { name: f.name })}
              </label>
              <input id={id} className={inputCls} value={postcode} maxLength={16} autoComplete="postal-code"
                onChange={(e) => set(f.id, e.target.value ? { postcode: e.target.value } : null)} />
              {unmatched.includes(f.id) && (
                <p className="mt-1 text-xs text-warning-text">
                  {t('quotes.factors.outsideZones', 'Outside the listed zones: travel is quoted on request.')}
                </p>
              )}
              {hint}
            </div>
          );
        }

        // choice, or a zone the admin picks
        const selected = f.inputType === 'zone'
          ? (value && typeof value === 'object' ? value.optionId ?? '' : '')
          : (typeof value === 'number' ? value : '');
        const zonePostcode = f.inputType === 'zone' && value && typeof value === 'object' ? value.postcode : undefined;
        return (
          <div key={f.id}>
            <label htmlFor={id} className={labelCls}>{f.name}</label>
            <select id={id} className={selectCls} value={String(selected)}
              onChange={(e) => {
                const optionId = e.target.value ? Number(e.target.value) : null;
                set(f.id, optionId == null ? null : f.inputType === 'zone' ? { optionId } : optionId);
              }}>
              <option value="">{t('quotes.factors.notSet', '—')}</option>
              {f.options.map((o) => <option key={o.id} value={String(o.id)}>{o.label}</option>)}
            </select>
            {zonePostcode && (
              <p className={css.muted}>
                {t('quotes.factors.fromPostcode', 'From postcode {{postcode}}', { postcode: zonePostcode })}
              </p>
            )}
            {hint}
          </div>
        );
      })}
    </div>
  );
};
