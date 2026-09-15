/**
 * Quote catalogue & templates (#1451). Five tabs:
 *   Services     — the catalogue items (the existing line-item presets)
 *   Packages     — bundles of catalogue items
 *   Promotions   — named discounts ("Vereinsrabatt −300 CHF", "−10 %")
 *   Text blocks  — reusable intro / scope / closing texts with {{placeholders}}
 *   Templates    — quote templates (edited on their own page)
 * Archived and draft entries are always listed; nothing is hard-deleted.
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowLeft, ArrowUp, Pencil, Plus, X } from 'lucide-react';
import { toast } from 'react-toastify';
import { Button, Card, Input, Loading, LocalizedDateInput } from '../../../../components/common';
import { DecimalInput } from '../../../../components/common/DecimalInput';
import { quotesService, type LineItemPreset } from '../../../../services/quotes.service';
import {
  quoteCatalogService,
  type QuotePackage, type QuotePromotion, type QuoteTextBlock, type TextBlockKind,
} from '../../../../services/quoteCatalog.service';
import { formatMoneyMinor } from '../../../../utils/money';
import { PermissionGate } from '../../../../components/admin/PermissionGate';
import { useLocalizedDate } from '../../../../hooks/useLocalizedDate';
import type { BoundTo, LineUnit, PriceMode } from '../../../../utils/lineItemTotals';

type Tab = 'services' | 'packages' | 'promotions' | 'textBlocks' | 'templates';
const TABS: Tab[] = ['services', 'packages', 'promotions', 'textBlocks', 'templates'];
const UNITS: LineUnit[] = ['hour', 'day', 'piece', 'km', 'flat'];
const CURRENCIES = ['CHF', 'EUR', 'USD', 'GBP'];
const TEXT_BLOCK_KINDS: TextBlockKind[] = ['intro', 'scope', 'note', 'closing', 'terms'];
const LANGUAGES = ['de', 'en', 'fr', 'nl', 'pt', 'ru'];
// Mirrors backend utils/placeholders QUOTE_PLACEHOLDERS.
const PLACEHOLDERS = [
  'customer_name', 'customer_company', 'event_name', 'event_date', 'quote_number', 'valid_until',
  'business_name', 'hours', 'days', 'hourly_rate', 'day_rate',
];

const inputCls = 'w-full px-3 py-2 rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-neutral-900';
// Native selects ignore vertical padding in Safari; a fixed height keeps them level with the inputs.
const selectCls = `${inputCls} h-10`;
const labelCls = 'block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1';
const toMinor = (major: number) => Math.round((Number.isFinite(major) ? major : 0) * 100);
// The API's message, plus what each rejected field says (a 400 lists them in `details`).
const errorText = (err: any): string => {
  const data = err?.response?.data;
  const details: Array<{ field?: string; message?: string }> = Array.isArray(data?.details) ? data.details : [];
  const reasons = details
    .map((d) => (d.message && d.message !== 'Invalid value' ? d.message : d.field ? `${d.field}: ${d.message || 'invalid'}` : null))
    .filter(Boolean);
  if (reasons.length) return reasons.join(' · ');
  return data?.error || err?.message || 'Failed';
};

const ArchivedBadge: React.FC = () => {
  const { t } = useTranslation();
  return (
    <span className="ml-2 rounded bg-neutral-200 dark:bg-neutral-700 px-1.5 py-0.5 text-[11px] text-neutral-600 dark:text-neutral-300">
      {t('quotes.catalog.archived', 'Archived')}
    </span>
  );
};

const RowActions: React.FC<{ active: boolean; onEdit: () => void; onArchive: () => void; onRestore: () => void }> = ({
  active, onEdit, onArchive, onRestore,
}) => {
  const { t } = useTranslation();
  // Writes need quotes.manage (the routes refuse them otherwise); admins with
  // only quotes.view see the catalogue read-only.
  return (
    <PermissionGate permission="quotes.manage">
      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onEdit}><Pencil className="w-3.5 h-3.5 mr-1" />{t('common.edit', 'Edit')}</Button>
        {active
          ? <Button variant="outline" size="sm" onClick={onArchive}>{t('quotes.catalog.archive', 'Archive')}</Button>
          : <Button variant="outline" size="sm" onClick={onRestore}>{t('quotes.catalog.restore', 'Restore')}</Button>}
      </div>
    </PermissionGate>
  );
};

// ---------------------------------------------------------------------
// Services (catalogue items)
// ---------------------------------------------------------------------

interface ServiceForm {
  id?: number;
  name: string;
  description: string;
  unitPrice: number;
  currency: string;
  quantityDefault: number;
  unit: LineUnit | '';
  priceMode: PriceMode;
  pinnedRate: number;
  category: string;
  detailsText: string;
}

const emptyService: ServiceForm = {
  name: '', description: '', unitPrice: NaN, currency: 'CHF', quantityDefault: 1, unit: '', priceMode: 'fixed',
  pinnedRate: NaN, category: '', detailsText: '',
};

const ServicesTab: React.FC = () => {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['line-item-presets', 'all'],
    queryFn: () => quotesService.listLineItemPresets({ includeInactive: true }),
  });
  const [form, setForm] = useState<ServiceForm | null>(null);

  const refresh = () => qc.invalidateQueries({ queryKey: ['line-item-presets'] });

  const edit = (p: LineItemPreset) => setForm({
    id: p.id,
    name: p.name,
    description: p.description || '',
    unitPrice: Number(p.unitPriceMinor || 0) / 100,
    currency: p.currency || 'CHF',
    quantityDefault: Number(p.quantityDefault) || 1,
    unit: p.unit || '',
    priceMode: p.priceMode || 'fixed',
    pinnedRate: p.pinnedRateMinor != null ? p.pinnedRateMinor / 100 : NaN,
    category: p.category || '',
    detailsText: p.detailsText || '',
  });

  const save = async () => {
    if (!form || !form.name.trim()) return;
    const rateBased = form.priceMode !== 'fixed';
    const payload = {
      name: form.name.trim(),
      description: form.description,
      unitPriceMinor: rateBased ? 0 : toMinor(form.unitPrice),
      currency: form.currency,
      quantityDefault: form.quantityDefault || 1,
      unit: form.unit || null,
      priceMode: form.priceMode,
      pinnedRateMinor: rateBased && Number.isFinite(form.pinnedRate) ? toMinor(form.pinnedRate) : null,
      category: form.category || null,
      detailsText: form.detailsText || null,
    };
    try {
      if (form.id) await quotesService.updateLineItemPreset(form.id, payload);
      else await quotesService.createLineItemPreset(payload);
      setForm(null);
      refresh();
      toast.success(t('quotes.catalog.savedToast', 'Saved.'));
    } catch (err) {
      toast.error(errorText(err));
    }
  };

  const setActive = async (p: LineItemPreset, isActive: boolean) => {
    try {
      if (isActive) await quotesService.updateLineItemPreset(p.id, { isActive: true });
      else await quotesService.archiveLineItemPreset(p.id);
      refresh();
    } catch (err) {
      toast.error(errorText(err));
    }
  };

  if (isLoading) return <Loading />;
  const presets = data?.presets || [];

  const priceLabel = (p: LineItemPreset) => {
    if (p.priceMode === 'hour' || p.priceMode === 'day') {
      const per = p.priceMode === 'hour' ? t('quotes.catalog.perHour', 'per hour') : t('quotes.catalog.perDay', 'per day');
      return p.pinnedRateMinor != null
        ? `${formatMoneyMinor(p.pinnedRateMinor, p.currency)} ${per}`
        : `${t('quotes.catalog.rateFromChain', 'Customer / default rate')} ${per}`;
    }
    return formatMoneyMinor(Number(p.unitPriceMinor || 0), p.currency);
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          {t('quotes.catalog.servicesIntro', 'Your services with a fixed price or priced by the hour / day. They appear in the quote editor\'s "Add from preset" list and in packages.')}
        </p>
        <PermissionGate permission="quotes.manage">
          <Button onClick={() => setForm({ ...emptyService })}><Plus className="w-4 h-4 mr-1" />{t('quotes.catalog.newService', 'New service')}</Button>
        </PermissionGate>
      </div>

      {form && (
        <Card padding="lg">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Input label={t('quotes.catalog.field.name', 'Name') as string} value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <Input label={t('quotes.catalog.field.category', 'Category') as string} value={form.category}
              onChange={(e) => setForm({ ...form, category: e.target.value })} />
            <div>
              <label htmlFor="service-price-mode" className={labelCls}>{t('quotes.catalog.field.priceMode', 'Price')}</label>
              <select id="service-price-mode" className={selectCls} value={form.priceMode}
                onChange={(e) => {
                  const priceMode = e.target.value as PriceMode;
                  setForm({ ...form, priceMode, unit: priceMode === 'fixed' ? form.unit : priceMode });
                }}>
                <option value="fixed">{t('quotes.catalog.priceMode.fixed', 'Fixed price')}</option>
                <option value="hour">{t('quotes.catalog.priceMode.hour', 'Per hour (rate)')}</option>
                <option value="day">{t('quotes.catalog.priceMode.day', 'Per day (rate)')}</option>
              </select>
            </div>
            {form.priceMode === 'fixed' ? (
              <div>
                <label htmlFor="service-unit-price" className={labelCls}>{t('quotes.catalog.field.unitPrice', 'Unit price')}</label>
                <DecimalInput id="service-unit-price" className={inputCls} value={form.unitPrice} fractionDigits={2}
                  onChange={(n) => setForm({ ...form, unitPrice: n })} />
              </div>
            ) : (
              <div>
                <label htmlFor="service-pinned-rate" className={labelCls}>{t('quotes.catalog.field.pinnedRate', 'Own rate (optional)')}</label>
                <DecimalInput id="service-pinned-rate" className={inputCls} value={form.pinnedRate} fractionDigits={2}
                  onChange={(n) => setForm({ ...form, pinnedRate: n })} />
                <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                  {t('quotes.catalog.field.pinnedRateHint', 'Leave blank to use the customer\'s rate, or the default rate from Settings → Accounting.')}
                </p>
              </div>
            )}
            <div>
              <label htmlFor="service-currency" className={labelCls}>{t('quotes.field.currency', 'Currency')}</label>
              <select id="service-currency" className={selectCls} value={form.currency}
                onChange={(e) => setForm({ ...form, currency: e.target.value })}>
                {CURRENCIES.map((c) => <option key={c}>{c}</option>)}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="service-quantity" className={labelCls}>{t('quotes.catalog.field.quantityDefault', 'Default quantity')}</label>
                <DecimalInput id="service-quantity" className={inputCls} value={form.quantityDefault}
                  onChange={(n) => setForm({ ...form, quantityDefault: Number.isFinite(n) ? n : 1 })} />
              </div>
              <div>
                <label htmlFor="service-unit" className={labelCls}>{t('crm.lineItems.unitLabel', 'Unit')}</label>
                <select id="service-unit" className={selectCls} value={form.unit}
                  onChange={(e) => setForm({ ...form, unit: e.target.value as LineUnit | '' })}>
                  <option value="">{t('crm.lineItems.unitNone', '—')}</option>
                  {UNITS.map((u) => <option key={u} value={u}>{t(`crm.lineItems.unitOption.${u}`, u)}</option>)}
                </select>
              </div>
            </div>
            <div className="md:col-span-2">
              <label htmlFor="service-description" className={labelCls}>{t('quotes.catalog.field.description', 'Description')}</label>
              <textarea id="service-description" rows={2} className={inputCls} value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })} />
            </div>
            <div className="md:col-span-2">
              <label htmlFor="service-details" className={labelCls}>{t('quotes.catalog.field.detailsText', 'Notes under the line')}</label>
              <textarea id="service-details" rows={2} className={inputCls} value={form.detailsText}
                onChange={(e) => setForm({ ...form, detailsText: e.target.value })} />
            </div>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setForm(null)}>{t('common.cancel', 'Cancel')}</Button>
            <Button onClick={save} disabled={!form.name.trim()}>{t('common.save', 'Save')}</Button>
          </div>
        </Card>
      )}

      <Card padding="lg">
        {presets.length === 0 ? (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">{t('quotes.catalog.emptyServices', 'No services yet.')}</p>
        ) : (
          <table className="w-full text-sm">
            <tbody>
              {presets.map((p) => (
                <tr key={p.id} className={`border-b border-neutral-100 dark:border-neutral-800 ${p.isActive ? '' : 'opacity-60'}`}>
                  <td className="py-2">
                    <span className="font-medium">{p.name}</span>
                    {!p.isActive && <ArchivedBadge />}
                    {p.category && <div className="text-xs text-neutral-500 dark:text-neutral-400">{p.category}</div>}
                  </td>
                  <td className="py-2 text-right tabular-nums">{priceLabel(p)}</td>
                  <td className="py-2">
                    <RowActions active={p.isActive} onEdit={() => edit(p)}
                      onArchive={() => setActive(p, false)} onRestore={() => setActive(p, true)} />
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

// ---------------------------------------------------------------------
// Packages
// ---------------------------------------------------------------------

interface PackageForm {
  id?: number;
  name: string;
  description: string;
  currency: string;
  items: Array<{ presetId: number; quantity: number; boundTo: BoundTo | '' }>;
}

const PackagesTab: React.FC = () => {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data: packages = [], isLoading } = useQuery({
    queryKey: ['quote-catalog', 'packages', 'all'],
    queryFn: () => quoteCatalogService.listPackages(),
  });
  const { data: presetData } = useQuery({
    queryKey: ['line-item-presets'],
    queryFn: () => quotesService.listLineItemPresets(),
  });
  const presets = presetData?.presets || [];
  const [form, setForm] = useState<PackageForm | null>(null);

  const refresh = () => qc.invalidateQueries({ queryKey: ['quote-catalog', 'packages'] });

  const edit = (p: QuotePackage) => setForm({
    id: p.id,
    name: p.name,
    description: p.description || '',
    currency: p.currency,
    items: p.items.map((it) => ({ presetId: it.presetId, quantity: it.quantity ?? NaN, boundTo: it.boundTo || '' })),
  });

  const setItems = (items: PackageForm['items']) => form && setForm({ ...form, items });

  const moveItem = (idx: number, dir: -1 | 1) => {
    if (!form) return;
    const other = idx + dir;
    if (other < 0 || other >= form.items.length) return;
    const items = [...form.items];
    [items[idx], items[other]] = [items[other], items[idx]];
    setItems(items);
  };

  const save = async () => {
    if (!form || !form.name.trim()) return;
    const payload = {
      name: form.name.trim(),
      description: form.description || null,
      currency: form.currency,
      items: form.items.map((it) => ({
        presetId: it.presetId,
        quantity: Number.isFinite(it.quantity) ? it.quantity : null,
        boundTo: it.boundTo || null,
      })),
    };
    try {
      if (form.id) await quoteCatalogService.updatePackage(form.id, payload);
      else await quoteCatalogService.createPackage(payload);
      setForm(null);
      refresh();
      toast.success(t('quotes.catalog.savedToast', 'Saved.'));
    } catch (err) {
      toast.error(errorText(err));
    }
  };

  const setActive = async (p: QuotePackage, isActive: boolean) => {
    try {
      if (isActive) await quoteCatalogService.updatePackage(p.id, { isActive: true });
      else await quoteCatalogService.archivePackage(p.id);
      refresh();
    } catch (err) {
      toast.error(errorText(err));
    }
  };

  if (isLoading) return <Loading />;

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          {t('quotes.catalog.packagesIntro', 'A package with one item shows its price on the package line; with several items, each item keeps its price and the package line shows the sum.')}
        </p>
        <PermissionGate permission="quotes.manage">
          <Button onClick={() => setForm({ name: '', description: '', currency: 'CHF', items: [] })}>
            <Plus className="w-4 h-4 mr-1" />{t('quotes.catalog.newPackage', 'New package')}
          </Button>
        </PermissionGate>
      </div>

      {form && (
        <Card padding="lg">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Input label={t('quotes.catalog.field.name', 'Name') as string} value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <div>
              <label htmlFor="package-currency" className={labelCls}>{t('quotes.field.currency', 'Currency')}</label>
              <select id="package-currency" className={selectCls} value={form.currency}
                onChange={(e) => setForm({ ...form, currency: e.target.value })}>
                {CURRENCIES.map((c) => <option key={c}>{c}</option>)}
              </select>
            </div>
            <div className="md:col-span-2">
              <label htmlFor="package-description" className={labelCls}>{t('quotes.catalog.field.description', 'Description')}</label>
              <textarea id="package-description" rows={2} className={inputCls} value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })} />
            </div>
          </div>

          <h4 className="mt-4 mb-2 text-sm font-semibold">{t('quotes.catalog.packageItems', 'Items')}</h4>
          <div className="space-y-2">
            {form.items.map((it, idx) => {
              const preset = presets.find((p) => p.id === it.presetId);
              const rateBased = preset?.priceMode === 'hour' || preset?.priceMode === 'day';
              return (
                <div key={idx} className="flex flex-wrap items-center gap-2">
                  <select aria-label={t('quotes.catalog.packageItem', 'Item') as string} className={`${selectCls} flex-1 min-w-[12rem]`} value={it.presetId}
                    onChange={(e) => setItems(form.items.map((x, i) => (i === idx ? { ...x, presetId: Number(e.target.value), boundTo: '' } : x)))}>
                    {!preset && <option value={it.presetId}>#{it.presetId}</option>}
                    {presets.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                  <DecimalInput aria-label={t('crm.lineItems.quantity', 'Qty') as string} className={`${inputCls} w-24`} value={it.quantity}
                    placeholder={preset ? String(preset.quantityDefault) : ''}
                    onChange={(n) => setItems(form.items.map((x, i) => (i === idx ? { ...x, quantity: n } : x)))} />
                  {rateBased && (
                    <select aria-label={t('quotes.catalog.boundTo', 'Quantity') as string} className={`${selectCls} w-auto`} value={it.boundTo}
                      onChange={(e) => setItems(form.items.map((x, i) => (i === idx ? { ...x, boundTo: e.target.value as BoundTo | '' } : x)))}>
                      <option value="">{t('quotes.catalog.boundToNone', 'Fixed quantity')}</option>
                      <option value="hours">{t('crm.lineItems.followsHours', 'Follows the quote hours')}</option>
                      <option value="days">{t('crm.lineItems.followsDays', 'Follows the quote days')}</option>
                    </select>
                  )}
                  <button type="button" onClick={() => moveItem(idx, -1)} aria-label="Move up" className="p-1 rounded hover:bg-neutral-100 dark:hover:bg-neutral-700"><ArrowUp className="w-4 h-4" /></button>
                  <button type="button" onClick={() => moveItem(idx, 1)} aria-label="Move down" className="p-1 rounded hover:bg-neutral-100 dark:hover:bg-neutral-700"><ArrowDown className="w-4 h-4" /></button>
                  <button type="button" onClick={() => setItems(form.items.filter((_, i) => i !== idx))} aria-label="Remove"
                    className="p-1 rounded hover:bg-red-50 dark:hover:bg-red-900/30 text-red-600"><X className="w-4 h-4" /></button>
                </div>
              );
            })}
            {presets.length > 0 && (
              <Button variant="outline" size="sm"
                onClick={() => setItems([...form.items, { presetId: presets[0].id, quantity: NaN, boundTo: '' }])}>
                <Plus className="w-4 h-4 mr-1" />{t('quotes.catalog.addItem', 'Add item')}
              </Button>
            )}
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setForm(null)}>{t('common.cancel', 'Cancel')}</Button>
            <Button onClick={save} disabled={!form.name.trim() || form.items.length === 0}>{t('common.save', 'Save')}</Button>
          </div>
        </Card>
      )}

      <Card padding="lg">
        {packages.length === 0 ? (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">{t('quotes.catalog.emptyPackages', 'No packages yet.')}</p>
        ) : (
          <table className="w-full text-sm">
            <tbody>
              {packages.map((p) => (
                <tr key={p.id} className={`border-b border-neutral-100 dark:border-neutral-800 ${p.isActive ? '' : 'opacity-60'}`}>
                  <td className="py-2">
                    <span className="font-medium">{p.name}</span>
                    {!p.isActive && <ArchivedBadge />}
                    <div className="text-xs text-neutral-500 dark:text-neutral-400">{p.items.map((it) => it.presetName).join(' · ')}</div>
                  </td>
                  <td className="py-2">
                    <RowActions active={p.isActive} onEdit={() => edit(p)}
                      onArchive={() => setActive(p, false)} onRestore={() => setActive(p, true)} />
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

// ---------------------------------------------------------------------
// Promotions
// ---------------------------------------------------------------------

interface PromotionForm {
  id?: number;
  name: string;
  description: string;
  type: 'percent' | 'fixed';
  percent: number;
  value: number;
  currency: string;
  validFrom: string;
  validUntil: string;
}

const PromotionsTab: React.FC = () => {
  const { t } = useTranslation();
  const { format: fmtDate } = useLocalizedDate();
  const qc = useQueryClient();
  const { data: promotions = [], isLoading } = useQuery({
    queryKey: ['quote-catalog', 'promotions', 'all'],
    queryFn: () => quoteCatalogService.listPromotions(),
  });
  const [form, setForm] = useState<PromotionForm | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['quote-catalog', 'promotions'] });

  const edit = (p: QuotePromotion) => setForm({
    id: p.id,
    name: p.name,
    description: p.description || '',
    type: p.type,
    percent: p.percent ?? NaN,
    value: p.valueMinor != null ? p.valueMinor / 100 : NaN,
    currency: p.currency || 'CHF',
    validFrom: p.validFrom || '',
    validUntil: p.validUntil || '',
  });

  const save = async () => {
    if (!form || !form.name.trim()) return;
    const payload = {
      name: form.name.trim(),
      description: form.description || null,
      type: form.type,
      // A promotion always subtracts, so "-300" and "300" both mean a 300 discount.
      percent: form.type === 'percent' && Number.isFinite(form.percent) ? Math.abs(form.percent) : null,
      valueMinor: form.type === 'fixed' && Number.isFinite(form.value) ? Math.abs(toMinor(form.value)) : null,
      currency: form.type === 'fixed' ? form.currency : null,
      validFrom: form.validFrom || null,
      validUntil: form.validUntil || null,
    };
    try {
      if (form.id) await quoteCatalogService.updatePromotion(form.id, payload);
      else await quoteCatalogService.createPromotion(payload);
      setForm(null);
      refresh();
      toast.success(t('quotes.catalog.savedToast', 'Saved.'));
    } catch (err) {
      toast.error(errorText(err));
    }
  };

  const setActive = async (p: QuotePromotion, isActive: boolean) => {
    try {
      if (isActive) await quoteCatalogService.updatePromotion(p.id, { isActive: true });
      else await quoteCatalogService.archivePromotion(p.id);
      refresh();
    } catch (err) {
      toast.error(errorText(err));
    }
  };

  if (isLoading) return <Loading />;

  const valueLabel = (p: QuotePromotion) => (p.type === 'percent'
    ? `−${p.percent} %`
    : `−${formatMoneyMinor(Number(p.valueMinor || 0), p.currency || 'CHF')}`);

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          {t('quotes.catalog.promotionsIntro', 'Ticked in the quote editor. Percentages apply first, then fixed amounts, before VAT — never more than the subtotal.')}
        </p>
        <PermissionGate permission="quotes.manage">
          <Button onClick={() => setForm({ name: '', description: '', type: 'fixed', percent: NaN, value: NaN, currency: 'CHF', validFrom: '', validUntil: '' })}>
            <Plus className="w-4 h-4 mr-1" />{t('quotes.catalog.newPromotion', 'New promotion')}
          </Button>
        </PermissionGate>
      </div>

      {form && (
        <Card padding="lg">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Input label={t('quotes.catalog.field.name', 'Name') as string} value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <div>
              <label htmlFor="promotion-type" className={labelCls}>{t('quotes.catalog.field.promotionType', 'Type')}</label>
              <select id="promotion-type" className={selectCls} value={form.type}
                onChange={(e) => setForm({ ...form, type: e.target.value as PromotionForm['type'] })}>
                <option value="fixed">{t('quotes.catalog.promotionType.fixed', 'Fixed amount')}</option>
                <option value="percent">{t('quotes.catalog.promotionType.percent', 'Percentage')}</option>
              </select>
            </div>
            {form.type === 'percent' ? (
              <div>
                <label htmlFor="promotion-percent" className={labelCls}>{t('quotes.catalog.field.percent', 'Percent')}</label>
                <DecimalInput id="promotion-percent" className={inputCls} value={form.percent}
                  aria-describedby="promotion-percent-hint" onChange={(n) => setForm({ ...form, percent: n })} />
                <p id="promotion-percent-hint" className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                  {t('quotes.catalog.promotionPercentHint', 'The percentage to subtract, e.g. 10 for −10 %.')}
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="promotion-value" className={labelCls}>{t('quotes.catalog.field.amount', 'Amount')}</label>
                  <DecimalInput id="promotion-value" className={inputCls} value={form.value} fractionDigits={2}
                    aria-describedby="promotion-value-hint" onChange={(n) => setForm({ ...form, value: n })} />
                  <p id="promotion-value-hint" className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                    {t('quotes.catalog.promotionAmountHint', 'The amount to subtract, e.g. 300 for −300.')}
                  </p>
                </div>
                <div>
                  <label htmlFor="promotion-currency" className={labelCls}>{t('quotes.field.currency', 'Currency')}</label>
                  <select id="promotion-currency" className={selectCls} value={form.currency}
                    onChange={(e) => setForm({ ...form, currency: e.target.value })}>
                    {CURRENCIES.map((c) => <option key={c}>{c}</option>)}
                  </select>
                </div>
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              <LocalizedDateInput label={t('quotes.catalog.field.validFrom', 'Valid from') as string} value={form.validFrom}
                onChange={(iso) => setForm({ ...form, validFrom: iso })} />
              <div>
                <LocalizedDateInput label={t('quotes.catalog.field.validUntil', 'Valid until') as string} value={form.validUntil}
                  onChange={(iso) => setForm({ ...form, validUntil: iso })} />
                <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                  {t('quotes.catalog.noEndDateHint', 'Leave empty for no end date.')}
                </p>
              </div>
            </div>
            <div className="md:col-span-2">
              <label htmlFor="promotion-description" className={labelCls}>{t('quotes.catalog.field.description', 'Description')}</label>
              <textarea id="promotion-description" rows={2} className={inputCls} value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })} />
            </div>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setForm(null)}>{t('common.cancel', 'Cancel')}</Button>
            <Button onClick={save} disabled={!form.name.trim()}>{t('common.save', 'Save')}</Button>
          </div>
        </Card>
      )}

      <Card padding="lg">
        {promotions.length === 0 ? (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">{t('quotes.catalog.emptyPromotions', 'No promotions yet.')}</p>
        ) : (
          <table className="w-full text-sm">
            <tbody>
              {promotions.map((p) => (
                <tr key={p.id} className={`border-b border-neutral-100 dark:border-neutral-800 ${p.isActive ? '' : 'opacity-60'}`}>
                  <td className="py-2">
                    <span className="font-medium">{p.name}</span>
                    {!p.isActive && <ArchivedBadge />}
                    <div className="text-xs text-neutral-500 dark:text-neutral-400">
                      {p.validUntil
                        ? `${p.validFrom ? `${fmtDate(p.validFrom)} – ` : `${t('quotes.catalog.validUntilOnly', 'Until')} `}${fmtDate(p.validUntil)}`
                        : p.validFrom
                          ? t('quotes.catalog.validFromNoEnd', 'From {{date}}, no end date', { date: fmtDate(p.validFrom) })
                          : t('quotes.catalog.noEndDate', 'No end date')}
                    </div>
                  </td>
                  <td className="py-2 text-right tabular-nums">{valueLabel(p)}</td>
                  <td className="py-2">
                    <RowActions active={p.isActive} onEdit={() => edit(p)}
                      onArchive={() => setActive(p, false)} onRestore={() => setActive(p, true)} />
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

// ---------------------------------------------------------------------
// Text blocks
// ---------------------------------------------------------------------

interface TextBlockForm {
  id?: number;
  kind: TextBlockKind;
  language: string;
  name: string;
  body: string;
}

const TextBlocksTab: React.FC = () => {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data: blocks = [], isLoading } = useQuery({
    queryKey: ['quote-catalog', 'text-blocks', 'all'],
    queryFn: () => quoteCatalogService.listTextBlocks(),
  });
  const [form, setForm] = useState<TextBlockForm | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['quote-catalog', 'text-blocks'] });

  const save = async () => {
    if (!form || !form.name.trim() || !form.body.trim()) return;
    const payload = { kind: form.kind, language: form.language, name: form.name.trim(), body: form.body };
    try {
      if (form.id) await quoteCatalogService.updateTextBlock(form.id, payload);
      else await quoteCatalogService.createTextBlock(payload);
      setForm(null);
      refresh();
      toast.success(t('quotes.catalog.savedToast', 'Saved.'));
    } catch (err) {
      toast.error(errorText(err));
    }
  };

  const setActive = async (b: QuoteTextBlock, isActive: boolean) => {
    try {
      if (isActive) await quoteCatalogService.updateTextBlock(b.id, { isActive: true });
      else await quoteCatalogService.archiveTextBlock(b.id);
      refresh();
    } catch (err) {
      toast.error(errorText(err));
    }
  };

  if (isLoading) return <Loading />;

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          {t('quotes.catalog.textBlocksIntro', 'Reusable texts for the quote intro and outro. Placeholders are filled in when the quote is saved.')}
        </p>
        <PermissionGate permission="quotes.manage">
          <Button onClick={() => setForm({ kind: 'intro', language: 'de', name: '', body: '' })}>
            <Plus className="w-4 h-4 mr-1" />{t('quotes.catalog.newTextBlock', 'New text block')}
          </Button>
        </PermissionGate>
      </div>

      {form && (
        <Card padding="lg">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <Input label={t('quotes.catalog.field.name', 'Name') as string} value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <div>
              <label htmlFor="text-block-kind" className={labelCls}>{t('quotes.catalog.field.kind', 'Kind')}</label>
              <select id="text-block-kind" className={selectCls} value={form.kind}
                onChange={(e) => setForm({ ...form, kind: e.target.value as TextBlockKind })}>
                {TEXT_BLOCK_KINDS.map((k) => <option key={k} value={k}>{t(`quotes.catalog.textBlockKind.${k}`, k)}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="text-block-language" className={labelCls}>{t('quotes.catalog.field.language', 'Language')}</label>
              <select id="text-block-language" className={selectCls} value={form.language}
                onChange={(e) => setForm({ ...form, language: e.target.value })}>
                {LANGUAGES.map((l) => <option key={l} value={l}>{l.toUpperCase()}</option>)}
              </select>
            </div>
            <div className="md:col-span-3">
              <label htmlFor="text-block-body" className={labelCls}>{t('quotes.catalog.field.body', 'Text')}</label>
              <textarea id="text-block-body" rows={5} className={inputCls} value={form.body}
                onChange={(e) => setForm({ ...form, body: e.target.value })} />
              <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                {t('quotes.catalog.placeholdersHint', 'Placeholders:')}{' '}
                <span className="font-mono">{PLACEHOLDERS.map((p) => `{{${p}}}`).join(' ')}</span>
              </p>
            </div>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setForm(null)}>{t('common.cancel', 'Cancel')}</Button>
            <Button onClick={save} disabled={!form.name.trim() || !form.body.trim()}>{t('common.save', 'Save')}</Button>
          </div>
        </Card>
      )}

      <Card padding="lg">
        {blocks.length === 0 ? (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">{t('quotes.catalog.emptyTextBlocks', 'No text blocks yet.')}</p>
        ) : (
          <table className="w-full text-sm">
            <tbody>
              {blocks.map((b) => (
                <tr key={b.id} className={`border-b border-neutral-100 dark:border-neutral-800 ${b.isActive ? '' : 'opacity-60'}`}>
                  <td className="py-2">
                    <span className="font-medium">{b.name}</span>
                    {!b.isActive && <ArchivedBadge />}
                    <div className="text-xs text-neutral-500 dark:text-neutral-400">
                      {t(`quotes.catalog.textBlockKind.${b.kind}`, b.kind)} · {b.language.toUpperCase()}
                    </div>
                  </td>
                  <td className="py-2">
                    <RowActions active={b.isActive}
                      onEdit={() => setForm({ id: b.id, kind: b.kind, language: b.language, name: b.name, body: b.body })}
                      onArchive={() => setActive(b, false)} onRestore={() => setActive(b, true)} />
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

// ---------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------

const TemplatesTab: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data: templates = [], isLoading } = useQuery({
    queryKey: ['quote-catalog', 'templates', 'all'],
    queryFn: () => quoteCatalogService.listTemplates(),
  });

  const create = async () => {
    const name = window.prompt(t('quotes.templates.newPrompt', 'Name for the new template'));
    if (!name || !name.trim()) return;
    try {
      const { template } = await quoteCatalogService.createTemplate({ name: name.trim() });
      navigate(`/admin/clients/quotes/catalog/templates/${template.id}`);
    } catch (err) {
      toast.error(errorText(err));
    }
  };

  if (isLoading) return <Loading />;

  const statusLabel = (status: string) => ({
    draft: t('quotes.templates.status.draft', 'Draft'),
    published: t('quotes.templates.status.published', 'Published'),
    archived: t('quotes.templates.status.archived', 'Archived'),
  } as Record<string, string>)[status] || status;

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          {t('quotes.catalog.templatesIntro', 'A template fills in a new quote. Publishing freezes a version, so later catalogue changes never alter quotes you already created.')}
        </p>
        <PermissionGate permission="quotes.manage">
          <Button onClick={create}><Plus className="w-4 h-4 mr-1" />{t('quotes.templates.newTemplate', 'New template')}</Button>
        </PermissionGate>
      </div>
      <Card padding="lg">
        {templates.length === 0 ? (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">{t('quotes.catalog.emptyTemplates', 'No templates yet.')}</p>
        ) : (
          <table className="w-full text-sm">
            <tbody>
              {templates.map((tpl) => (
                <tr key={tpl.id} className={`border-b border-neutral-100 dark:border-neutral-800 ${tpl.status === 'archived' ? 'opacity-60' : ''}`}>
                  <td className="py-2">
                    <Link to={`/admin/clients/quotes/catalog/templates/${tpl.id}`} className="font-medium hover:underline">{tpl.name}</Link>
                    {tpl.description && <div className="text-xs text-neutral-500 dark:text-neutral-400">{tpl.description}</div>}
                  </td>
                  <td className="py-2 text-sm text-neutral-600 dark:text-neutral-400">
                    {statusLabel(tpl.status)}
                    {tpl.currentVersion != null && ` · v${tpl.currentVersion}`}
                  </td>
                  <td className="py-2 text-right">
                    <Link to={`/admin/clients/quotes/catalog/templates/${tpl.id}`}>
                      <Button variant="outline" size="sm"><Pencil className="w-3.5 h-3.5 mr-1" />{t('common.edit', 'Edit')}</Button>
                    </Link>
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

// ---------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------

export const QuoteCatalogPage: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get('tab') as Tab | null;
  const tab: Tab = requested && TABS.includes(requested) ? requested : 'services';

  const tabLabel = (key: Tab) => ({
    services: t('quotes.catalog.tab.services', 'Services'),
    packages: t('quotes.catalog.tab.packages', 'Packages'),
    promotions: t('quotes.catalog.tab.promotions', 'Promotions'),
    textBlocks: t('quotes.catalog.tab.textBlocks', 'Text blocks'),
    templates: t('quotes.catalog.tab.templates', 'Templates'),
  })[key];

  return (
    <div className="space-y-4">
      <div>
        <button onClick={() => navigate('/admin/clients/quotes')}
          className="text-sm text-neutral-600 dark:text-neutral-400 hover:underline mb-1 inline-flex items-center gap-1">
          <ArrowLeft className="w-4 h-4" /> {t('common.back', 'Back')}
        </button>
        <h2 className="text-xl font-bold text-neutral-900 dark:text-neutral-100">{t('quotes.catalog.title', 'Catalogue & templates')}</h2>
      </div>

      <div role="tablist" className="flex flex-wrap gap-1 border-b border-neutral-200 dark:border-neutral-700">
        {TABS.map((key) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            onClick={() => setSearchParams({ tab: key })}
            className={`px-3 py-2 text-sm -mb-px border-b-2 ${tab === key
              ? 'border-primary-600 dark:border-primary-400 text-neutral-900 dark:text-neutral-100 font-medium'
              : 'border-transparent text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100'}`}
          >
            {tabLabel(key)}
          </button>
        ))}
      </div>

      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        {t('quotes.catalog.examplesHint', 'Archived entries named "Example: …" show how each part works. Edit one and restore it to use it.')}
      </p>

      {tab === 'services' && <ServicesTab />}
      {tab === 'packages' && <PackagesTab />}
      {tab === 'promotions' && <PromotionsTab />}
      {tab === 'textBlocks' && <TextBlocksTab />}
      {tab === 'templates' && <TemplatesTab />}
    </div>
  );
};
