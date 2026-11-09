/**
 * Catalogue → Pricing factors (#2440). The factor library: inputs that change
 * a service's price — session length, kind of work, travel zone, editing
 * effort, number of deliverables. Factors are attached to services on the
 * Services tab; archived factors stay on the services that already use them.
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, X } from 'lucide-react';
import { toast } from 'react-toastify';
import { Button, Card, Input, Loading } from '../../../../components/common';
import { DecimalInput } from '../../../../components/common/DecimalInput';
import { PermissionGate } from '../../../../components/admin/PermissionGate';
import {
  quoteCatalogService,
  type FactorEffect, type FactorInputType, type PricingFactor, type PricingFactorOption,
} from '../../../../services/quoteCatalog.service';
import { formatMoneyMinor } from '../../../../utils/money';

const INPUT_TYPES: FactorInputType[] = ['number', 'choice', 'zone', 'toggle'];
const CURRENCIES = ['CHF', 'EUR', 'USD', 'GBP'];

const inputCls = 'w-full px-3 py-2 rounded-md border border-line-strong bg-panel text-heading text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 dark:focus-visible:ring-offset-neutral-900';
const selectCls = `${inputCls} h-10`;
const labelCls = 'block text-sm font-medium text-body mb-1';
const toMinor = (major: number) => Math.round((Number.isFinite(major) ? major : 0) * 100);
const fromMinor = (minor: number | null | undefined) => (minor == null ? NaN : minor / 100);
const orNull = (n: number) => (Number.isFinite(n) ? n : null);
const errorText = (err: any): string => err?.response?.data?.error || err?.message || 'Failed';

interface OptionForm {
  id?: number;
  label: string;
  effect: 'fixed' | 'percent';
  amount: number;
  percent: number;
  postcodes: string;
}

interface FactorForm {
  id?: number;
  name: string;
  description: string;
  inputType: FactorInputType;
  effect: FactorEffect;
  unitLabel: string;
  currency: string;
  amount: number;
  percent: number;
  includedUnits: number;
  stepSize: number;
  minValue: number;
  maxValue: number;
  defaultValue: string;
  clientVisible: boolean;
  options: OptionForm[];
}

const emptyOption = (): OptionForm => ({ label: '', effect: 'fixed', amount: NaN, percent: NaN, postcodes: '' });

const emptyFactor = (): FactorForm => ({
  name: '', description: '', inputType: 'number', effect: 'per_unit', unitLabel: '', currency: 'CHF',
  amount: NaN, percent: NaN, includedUnits: NaN, stepSize: NaN, minValue: NaN, maxValue: NaN,
  defaultValue: '', clientVisible: true, options: [],
});

const defaultEffect = (type: FactorInputType): FactorEffect => (type === 'number' ? 'per_unit' : 'fixed');

export const PricingFactorsTab: React.FC = () => {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data: factors = [], isLoading } = useQuery({
    queryKey: ['quote-catalog', 'factors', 'all'],
    queryFn: () => quoteCatalogService.listFactors(),
  });
  const [form, setForm] = useState<FactorForm | null>(null);

  const refresh = () => qc.invalidateQueries({ queryKey: ['quote-catalog', 'factors'] });

  const edit = (f: PricingFactor) => setForm({
    id: f.id,
    name: f.name,
    description: f.description || '',
    inputType: f.inputType,
    effect: f.effect || defaultEffect(f.inputType),
    unitLabel: f.unitLabel || '',
    currency: f.currency,
    amount: fromMinor(f.amountMinor),
    percent: f.percent ?? NaN,
    includedUnits: f.includedUnits ?? NaN,
    stepSize: f.stepSize ?? NaN,
    minValue: f.minValue ?? NaN,
    maxValue: f.maxValue ?? NaN,
    defaultValue: f.defaultValue || '',
    clientVisible: f.clientVisible,
    options: f.options.map((o) => ({
      id: o.id, label: o.label, effect: o.effect, amount: fromMinor(o.amountMinor), percent: o.percent ?? NaN, postcodes: o.postcodes || '',
    })),
  });

  const save = async () => {
    if (!form || !form.name.trim()) return;
    const withOptions = form.inputType === 'choice' || form.inputType === 'zone';
    const percentEffect = form.inputType === 'toggle' && form.effect === 'percent';
    const payload: Partial<PricingFactor> & { name: string; inputType: FactorInputType } = {
      name: form.name.trim(),
      description: form.description || null,
      inputType: form.inputType,
      effect: withOptions ? null : form.effect,
      unitLabel: form.inputType === 'number' ? form.unitLabel || null : null,
      currency: form.currency,
      amountMinor: withOptions || percentEffect ? null : toMinor(form.amount),
      percent: percentEffect ? orNull(form.percent) ?? 0 : null,
      includedUnits: form.inputType === 'number' ? orNull(form.includedUnits) : null,
      stepSize: form.inputType === 'number' && form.effect === 'step' ? orNull(form.stepSize) : null,
      minValue: form.inputType === 'number' ? orNull(form.minValue) : null,
      maxValue: form.inputType === 'number' ? orNull(form.maxValue) : null,
      defaultValue: form.defaultValue || null,
      clientVisible: form.clientVisible,
      options: withOptions
        ? form.options.map((o): PricingFactorOption => ({
          id: o.id,
          label: o.label.trim(),
          effect: o.effect,
          amountMinor: o.effect === 'fixed' ? toMinor(o.amount) : null,
          percent: o.effect === 'percent' ? orNull(o.percent) ?? 0 : null,
          postcodes: form.inputType === 'zone' ? o.postcodes : null,
        }))
        : [],
    };
    try {
      if (form.id) await quoteCatalogService.updateFactor(form.id, payload);
      else await quoteCatalogService.createFactor(payload);
      setForm(null);
      refresh();
      toast.success(t('quotes.catalog.savedToast', 'Saved.'));
    } catch (err) {
      toast.error(errorText(err));
    }
  };

  const setActive = async (f: PricingFactor, isActive: boolean) => {
    try {
      if (isActive) await quoteCatalogService.updateFactor(f.id, { isActive: true });
      else await quoteCatalogService.archiveFactor(f.id);
      refresh();
    } catch (err) {
      toast.error(errorText(err));
    }
  };

  const typeLabel = (type: FactorInputType) => ({
    number: t('quotes.factors.type.number', 'Number'),
    choice: t('quotes.factors.type.choice', 'Choice'),
    zone: t('quotes.factors.type.zone', 'Travel zone'),
    toggle: t('quotes.factors.type.toggle', 'Yes / no'),
  })[type];

  const effectSummary = (f: PricingFactor) => {
    const money = (minor: number | null) => formatMoneyMinor(minor || 0, f.currency);
    if (f.inputType === 'number') {
      const unit = f.unitLabel || t('quotes.factors.unitFallback', 'unit');
      return f.effect === 'step'
        ? t('quotes.factors.summary.step', '{{amount}} per started {{step}} {{unit}}', { amount: money(f.amountMinor), step: f.stepSize, unit })
        : t('quotes.factors.summary.perUnit', '{{amount}} per {{unit}}', { amount: money(f.amountMinor), unit });
    }
    if (f.inputType === 'toggle') {
      return f.effect === 'percent' ? `+${f.percent ?? 0} %` : `+${money(f.amountMinor)}`;
    }
    return t('quotes.factors.summary.options', '{{count}} options', { count: f.options.length });
  };

  if (isLoading) return <Loading />;

  const setOption = (index: number, patch: Partial<OptionForm>) => form && setForm({
    ...form, options: form.options.map((o, i) => (i === index ? { ...o, ...patch } : o)),
  });

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center gap-4">
        <p className="text-sm text-soft">
          {t('quotes.factors.intro', 'Inputs that change a service\'s price, such as session length, kind of work, travel zone or editing effort. Attach them to services on the Services tab.')}
        </p>
        <PermissionGate permission="quotes.manage">
          <Button onClick={() => setForm(emptyFactor())}><Plus className="w-4 h-4 mr-1" />{t('quotes.factors.new', 'New factor')}</Button>
        </PermissionGate>
      </div>

      {form && (
        <Card padding="lg">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Input label={t('quotes.catalog.field.name', 'Name') as string} value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <div>
              <label htmlFor="factor-type" className={labelCls}>{t('quotes.factors.field.type', 'Input')}</label>
              <select id="factor-type" className={selectCls} value={form.inputType}
                onChange={(e) => {
                  const inputType = e.target.value as FactorInputType;
                  setForm({
                    ...form, inputType, effect: defaultEffect(inputType), defaultValue: '',
                    options: (inputType === 'choice' || inputType === 'zone') && form.options.length === 0 ? [emptyOption()] : form.options,
                  });
                }}>
                {INPUT_TYPES.map((type) => <option key={type} value={type}>{typeLabel(type)}</option>)}
              </select>
            </div>

            {form.inputType === 'number' && (
              <>
                <div>
                  <label htmlFor="factor-effect" className={labelCls}>{t('quotes.factors.field.effect', 'Price change')}</label>
                  <select id="factor-effect" className={selectCls} value={form.effect}
                    onChange={(e) => setForm({ ...form, effect: e.target.value as FactorEffect })}>
                    <option value="per_unit">{t('quotes.factors.effect.perUnit', 'Amount per unit')}</option>
                    <option value="step">{t('quotes.factors.effect.step', 'Amount per started step')}</option>
                  </select>
                </div>
                <Input label={t('quotes.factors.field.unitLabel', 'Unit (e.g. h, videos)') as string} value={form.unitLabel}
                  onChange={(e) => setForm({ ...form, unitLabel: e.target.value })} />
                <div>
                  <label htmlFor="factor-amount" className={labelCls}>
                    {form.effect === 'step' ? t('quotes.factors.field.amountPerStep', 'Amount per step') : t('quotes.factors.field.amountPerUnit', 'Amount per unit')}
                  </label>
                  <DecimalInput id="factor-amount" className={inputCls} value={form.amount} fractionDigits={2}
                    onChange={(amount) => setForm({ ...form, amount })} />
                </div>
                {form.effect === 'step' && (
                  <div>
                    <label htmlFor="factor-step" className={labelCls}>{t('quotes.factors.field.stepSize', 'Step size')}</label>
                    <DecimalInput id="factor-step" className={inputCls} value={form.stepSize}
                      onChange={(stepSize) => setForm({ ...form, stepSize })} />
                  </div>
                )}
                <div>
                  <label htmlFor="factor-included" className={labelCls}>{t('quotes.factors.field.included', 'Included in the base price')}</label>
                  <DecimalInput id="factor-included" className={inputCls} value={form.includedUnits}
                    onChange={(includedUnits) => setForm({ ...form, includedUnits })} />
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <label htmlFor="factor-min" className={labelCls}>{t('quotes.factors.field.min', 'Minimum')}</label>
                    <DecimalInput id="factor-min" className={inputCls} value={form.minValue}
                      onChange={(minValue) => setForm({ ...form, minValue })} />
                  </div>
                  <div>
                    <label htmlFor="factor-max" className={labelCls}>{t('quotes.factors.field.max', 'Maximum')}</label>
                    <DecimalInput id="factor-max" className={inputCls} value={form.maxValue}
                      onChange={(maxValue) => setForm({ ...form, maxValue })} />
                  </div>
                  <div>
                    <label htmlFor="factor-default" className={labelCls}>{t('quotes.factors.field.default', 'Default')}</label>
                    <DecimalInput id="factor-default" className={inputCls}
                      value={form.defaultValue === '' ? NaN : Number(form.defaultValue)}
                      onChange={(v) => setForm({ ...form, defaultValue: Number.isFinite(v) ? String(v) : '' })} />
                  </div>
                </div>
              </>
            )}

            {form.inputType === 'toggle' && (
              <>
                <div>
                  <label htmlFor="factor-toggle-effect" className={labelCls}>{t('quotes.factors.field.effect', 'Price change')}</label>
                  <select id="factor-toggle-effect" className={selectCls} value={form.effect}
                    onChange={(e) => setForm({ ...form, effect: e.target.value as FactorEffect })}>
                    <option value="fixed">{t('quotes.factors.effect.fixed', 'Fixed amount')}</option>
                    <option value="percent">{t('quotes.factors.effect.percent', 'Percent of the base price')}</option>
                  </select>
                </div>
                {form.effect === 'percent' ? (
                  <div>
                    <label htmlFor="factor-percent" className={labelCls}>{t('quotes.factors.field.percent', 'Percent')}</label>
                    <DecimalInput id="factor-percent" className={inputCls} value={form.percent} fractionDigits={2}
                      onChange={(percent) => setForm({ ...form, percent })} />
                  </div>
                ) : (
                  <div>
                    <label htmlFor="factor-toggle-amount" className={labelCls}>{t('quotes.factors.field.amount', 'Amount')}</label>
                    <DecimalInput id="factor-toggle-amount" className={inputCls} value={form.amount} fractionDigits={2}
                      onChange={(amount) => setForm({ ...form, amount })} />
                  </div>
                )}
                <label className="flex items-center gap-2 text-sm text-body md:col-span-2">
                  <input type="checkbox" checked={form.defaultValue === 'true'}
                    onChange={(e) => setForm({ ...form, defaultValue: e.target.checked ? 'true' : '' })} />
                  {t('quotes.factors.field.toggleDefault', 'On by default')}
                </label>
              </>
            )}

            <div>
              <label htmlFor="factor-currency" className={labelCls}>{t('quotes.field.currency', 'Currency')}</label>
              <select id="factor-currency" className={selectCls} value={form.currency}
                onChange={(e) => setForm({ ...form, currency: e.target.value })}>
                {CURRENCIES.map((c) => <option key={c}>{c}</option>)}
              </select>
            </div>
            <label className="flex items-center gap-2 text-sm text-body self-end pb-2">
              <input type="checkbox" checked={form.clientVisible}
                onChange={(e) => setForm({ ...form, clientVisible: e.target.checked })} />
              {t('quotes.factors.field.clientVisible', 'Client fills this in when booking')}
            </label>

            <div className="md:col-span-2">
              <label htmlFor="factor-description" className={labelCls}>{t('quotes.catalog.field.description', 'Description')}</label>
              <textarea id="factor-description" rows={2} className={inputCls} value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })} />
            </div>
          </div>

          {(form.inputType === 'choice' || form.inputType === 'zone') && (
            <div className="mt-4 space-y-2">
              <div className="text-sm font-medium text-body">
                {form.inputType === 'zone' ? t('quotes.factors.zones', 'Zones') : t('quotes.factors.options', 'Options')}
              </div>
              {form.inputType === 'zone' && (
                <p className="text-xs text-muted">
                  {t('quotes.factors.zonesHint', 'One postcode per line: 8001 exact, 80* starts with, 8000-8099 range. The first zone that matches wins. A postcode in no zone is marked "travel on request".')}
                </p>
              )}
              {form.options.map((o, index) => (
                <div key={o.id ?? `new-${index}`} className="rounded-md border border-line p-3 grid grid-cols-1 md:grid-cols-[2fr_1fr_1fr_auto] gap-2 items-start">
                  <input aria-label={t('quotes.factors.field.optionLabel', 'Label') as string} className={inputCls} value={o.label}
                    placeholder={t('quotes.factors.field.optionLabel', 'Label') as string}
                    onChange={(e) => setOption(index, { label: e.target.value })} />
                  <select aria-label={t('quotes.factors.field.effect', 'Price change') as string} className={selectCls} value={o.effect}
                    onChange={(e) => setOption(index, { effect: e.target.value as OptionForm['effect'] })}>
                    <option value="fixed">{t('quotes.factors.effect.fixed', 'Fixed amount')}</option>
                    <option value="percent">{t('quotes.factors.effect.percent', 'Percent of the base price')}</option>
                  </select>
                  {o.effect === 'percent' ? (
                    <DecimalInput aria-label={t('quotes.factors.field.percent', 'Percent') as string} className={inputCls} value={o.percent} fractionDigits={2}
                      onChange={(percent) => setOption(index, { percent })} />
                  ) : (
                    <DecimalInput aria-label={t('quotes.factors.field.amount', 'Amount') as string} className={inputCls} value={o.amount} fractionDigits={2}
                      onChange={(amount) => setOption(index, { amount })} />
                  )}
                  <Button variant="outline" size="sm" aria-label={t('common.remove', 'Remove') as string}
                    onClick={() => setForm({ ...form, options: form.options.filter((_, i) => i !== index) })}>
                    <X className="w-3.5 h-3.5" />
                  </Button>
                  {form.inputType === 'zone' && (
                    <textarea aria-label={t('quotes.factors.field.postcodes', 'Postcodes') as string} rows={2}
                      className={`${inputCls} md:col-span-4 font-mono`} value={o.postcodes}
                      placeholder={t('quotes.factors.field.postcodes', 'Postcodes') as string}
                      onChange={(e) => setOption(index, { postcodes: e.target.value })} />
                  )}
                </div>
              ))}
              <Button variant="outline" size="sm" onClick={() => setForm({ ...form, options: [...form.options, emptyOption()] })}>
                <Plus className="w-3.5 h-3.5 mr-1" />
                {form.inputType === 'zone' ? t('quotes.factors.addZone', 'Add zone') : t('quotes.factors.addOption', 'Add option')}
              </Button>
              {form.options.some((o) => o.id) && (
                <div className="max-w-sm">
                  <label htmlFor="factor-default-option" className={labelCls}>{t('quotes.factors.field.default', 'Default')}</label>
                  <select id="factor-default-option" className={selectCls} value={form.defaultValue}
                    onChange={(e) => setForm({ ...form, defaultValue: e.target.value })}>
                    <option value="">{t('quotes.factors.noDefault', 'None')}</option>
                    {form.options.filter((o) => o.id).map((o) => <option key={o.id} value={String(o.id)}>{o.label}</option>)}
                  </select>
                </div>
              )}
            </div>
          )}

          <div className="mt-4 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setForm(null)}>{t('common.cancel', 'Cancel')}</Button>
            <Button onClick={save} disabled={!form.name.trim()}>{t('common.save', 'Save')}</Button>
          </div>
        </Card>
      )}

      <Card padding="lg">
        {factors.length === 0 ? (
          <p className="text-sm text-muted">{t('quotes.factors.empty', 'No pricing factors yet.')}</p>
        ) : (
          <table className="w-full text-sm">
            <tbody>
              {factors.map((f) => (
                <tr key={f.id} className={`border-b border-line-faint ${f.isActive ? '' : 'opacity-60'}`}>
                  <td className="py-2">
                    <span className="font-medium">{f.name}</span>
                    {!f.isActive && (
                      <span className="ml-2 rounded bg-fill px-1.5 py-0.5 text-[11px] text-body">{t('quotes.catalog.archived', 'Archived')}</span>
                    )}
                    <div className="text-xs text-muted">
                      {typeLabel(f.inputType)}
                      {!f.clientVisible && ` · ${t('quotes.factors.adminOnly', 'admin only')}`}
                    </div>
                  </td>
                  <td className="py-2 text-right tabular-nums">{effectSummary(f)}</td>
                  <td className="py-2">
                    <PermissionGate permission="quotes.manage">
                      <div className="flex flex-wrap justify-end gap-2">
                        <Button variant="outline" size="sm" onClick={() => edit(f)}>{t('common.edit', 'Edit')}</Button>
                        {f.isActive
                          ? <Button variant="outline" size="sm" onClick={() => setActive(f, false)}>{t('quotes.catalog.archive', 'Archive')}</Button>
                          : <Button variant="outline" size="sm" onClick={() => setActive(f, true)}>{t('quotes.catalog.restore', 'Restore')}</Button>}
                      </div>
                    </PermissionGate>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
};
