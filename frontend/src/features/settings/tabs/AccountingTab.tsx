/**
 * Accounting settings tab — rates used by internal expenses + the proof
 * requirement. Rates are CHF; stored as integer minor units. Tax/legal
 * guidance only — verify with your Treuhaender.
 */
import React, { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-toastify';
import { Save } from 'lucide-react';
import { Button, Card, CardContent, Input, Loading } from '../../../components/common';
import { DecimalInput } from '../../../components/common/DecimalInput';
import { accountingService } from '../../../services/accounting.service';
import { businessProfileService } from '../../../services/businessProfile.service';
import { vatCodesService } from '../../../services/vatCodes.service';
import { sortedCountryOptions } from '../../../constants/countries';
import { VatCodesManager } from '../../../components/admin/VatCodesManager';
import { ChartOfAccountsManager } from '../../../components/admin/ChartOfAccountsManager';

const labelCls = 'block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1';
const inputCls = 'w-full max-w-xs rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 px-3 py-2 text-sm';

export const AccountingTab: React.FC = () => {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['accounting-settings'], queryFn: () => accountingService.getSettings() });
  const { data: outputVatCodes = [] } = useQuery({ queryKey: ['vat-codes', 'output'], queryFn: () => vatCodesService.listOutput() });
  // VAT label + default hourly rate live on business_profile, surfaced here so
  // all financial/VAT config sits in one tab (and one Save).
  const { data: profileSnap } = useQuery({ queryKey: ['business-profile'], queryFn: () => businessProfileService.get() });

  const [kmMajor, setKmMajor] = useState<number>(NaN);
  const [perDiemMajor, setPerDiemMajor] = useState<number>(NaN);
  const [hourlyMajor, setHourlyMajor] = useState<number>(NaN);
  const [requireProof, setRequireProof] = useState(false);
  const [vatRegistered, setVatRegistered] = useState(false);
  const [reclaimCountries, setReclaimCountries] = useState<string[]>([]);
  const [defaultOutputVatCode, setDefaultOutputVatCode] = useState('');
  const [vatLabel, setVatLabel] = useState('');

  useEffect(() => {
    if (data) {
      setKmMajor(data.accounting_km_rate_minor / 100);
      setPerDiemMajor(data.accounting_per_diem_rate_minor / 100);
      setRequireProof(data.accounting_require_proof);
      setVatRegistered(data.accounting_vat_registered);
      setReclaimCountries(data.accounting_vat_reclaim_countries || []);
      setDefaultOutputVatCode(data.accounting_default_output_vat_code || '');
    }
  }, [data]);
  useEffect(() => {
    if (profileSnap?.profile) {
      setVatLabel(profileSnap.profile.vatLabel || '');
      setHourlyMajor(profileSnap.profile.defaultHourlyRateMinor != null ? profileSnap.profile.defaultHourlyRateMinor / 100 : NaN);
    }
  }, [profileSnap]);

  const countries = sortedCountryOptions(i18n.language);
  const currency = profileSnap?.profile?.defaultCurrency || 'CHF';

  // One Save persists BOTH the app_settings (rates/VAT/proof) and the two
  // business_profile fields (VAT label + hourly rate).
  const save = useMutation({
    mutationFn: async () => {
      await accountingService.updateSettings({
        accounting_km_rate_minor: Number.isFinite(kmMajor) ? Math.round(kmMajor * 100) : 0,
        accounting_per_diem_rate_minor: Number.isFinite(perDiemMajor) ? Math.round(perDiemMajor * 100) : 0,
        accounting_require_proof: requireProof,
        accounting_vat_registered: vatRegistered,
        accounting_vat_reclaim_countries: reclaimCountries,
        accounting_default_output_vat_code: defaultOutputVatCode,
      });
      await businessProfileService.update({
        vatLabel: vatLabel || '',
        defaultHourlyRateMinor: Number.isFinite(hourlyMajor) ? Math.max(0, Math.round(hourlyMajor * 100)) : null,
      });
    },
    onSuccess: () => {
      toast.success(t('settings.accounting.savedToast', 'Accounting settings saved.'));
      qc.invalidateQueries({ queryKey: ['accounting-settings'] });
      qc.invalidateQueries({ queryKey: ['business-profile'] });
    },
    onError: (e: any) => toast.error(e?.response?.data?.error || e.message || 'Failed'),
  });

  if (isLoading) return <Loading />;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-neutral-900 dark:text-neutral-100">{t('settings.accounting.title', 'Accounting')}</h2>
        <p className="text-neutral-600 dark:text-neutral-400 mt-1">{t('settings.accounting.subtitle', 'Default rates for internal expenses and the proof requirement.')}</p>
      </div>

      <Card><CardContent className="p-5 space-y-4">
        <div>
          <label className={labelCls}>{t('settings.accounting.kmRate', 'Mileage rate (CHF / km)')}</label>
          <DecimalInput value={kmMajor} onChange={setKmMajor} fractionDigits={2} className={inputCls} />
          <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">{t('settings.accounting.kmRateHint', 'Default applied to mileage expenses; overridable per entry.')}</p>
        </div>
        <div>
          <label className={labelCls}>{t('settings.accounting.perDiemRate', 'Daily allowance (CHF / day)')}</label>
          <DecimalInput value={perDiemMajor} onChange={setPerDiemMajor} fractionDigits={2} className={inputCls} />
          <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">{t('settings.accounting.perDiemRateHint', 'A flat daily allowance booked as an expense (not a client billing rate); overridable per entry.')}</p>
        </div>
        <div>
          <label className={labelCls}>{t('settings.accounting.profileFields.hourlyRate', 'Default hourly rate')}</label>
          <DecimalInput value={hourlyMajor} onChange={setHourlyMajor} fractionDigits={2} className={inputCls} placeholder={t('settings.accounting.profileFields.hourlyRatePlaceholder', 'e.g. 120.00') as string} />
          <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">{t('settings.accounting.profileFields.hourlyRateHint', 'Billing fallback used when a customer has no own rate (hours logging). In {{currency}}, major units. Leave blank to require a per-customer or per-entry rate.', { currency })}</p>
        </div>
        <label className="flex items-center gap-2 text-sm text-neutral-800 dark:text-neutral-200">
          <input type="checkbox" checked={requireProof} onChange={(e) => setRequireProof(e.target.checked)} className="rounded border-neutral-300" />
          {t('settings.accounting.requireProof', 'Require a proof file on every expense')}
        </label>
        <p className="text-xs text-amber-600 dark:text-amber-400">{t('settings.accounting.disclaimer', 'Rates and VAT/tax treatment are guidance only — verify with your Treuhaender.')}</p>
      </CardContent></Card>

      {/* VAT registration & reclaim — drives whether output/input VAT applies
          and which countries' input VAT is deductible (cost tax-treatment +
          the tax report's VAT-payable). */}
      <Card><CardContent className="p-5 space-y-4">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
          {t('settings.accounting.vat.title', 'VAT')}
        </h3>
        <label className="flex items-start gap-2 text-sm text-neutral-800 dark:text-neutral-200">
          <input type="checkbox" checked={vatRegistered} onChange={(e) => setVatRegistered(e.target.checked)} className="mt-0.5 rounded border-neutral-300" />
          <span>
            {t('settings.accounting.vat.registered', 'VAT-registered (charge output VAT + reclaim input VAT)')}
            <span className="block text-xs text-neutral-500 dark:text-neutral-400">
              {t('settings.accounting.vat.registeredHint', 'Off = small business / under threshold: no VAT charged, input VAT is a cost (not reclaimable).')}
            </span>
          </span>
        </label>
        <div className={vatRegistered ? '' : 'opacity-50 pointer-events-none'}>
          <label className={labelCls}>{t('settings.accounting.vat.reclaimCountries', 'Countries where input VAT is reclaimable')}</label>
          <select
            multiple
            size={6}
            value={reclaimCountries}
            onChange={(e) => setReclaimCountries(Array.from(e.target.selectedOptions, (o) => o.value))}
            className="w-full max-w-xs rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 px-3 py-2 text-sm"
          >
            {countries.map((c) => (
              <option key={c.code} value={c.code}>{c.label}</option>
            ))}
          </select>
          <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
            {t('settings.accounting.vat.reclaimCountriesHint', 'Typically your domestic country (CH / LI). Costs from other countries are treated as non-reclaimable foreign VAT. Cmd/Ctrl-click to multi-select.')}
          </p>
        </div>
        <div>
          <label className={labelCls}>{t('settings.accounting.vat.defaultOutputCode', 'Default VAT code for new invoices')}</label>
          <select value={defaultOutputVatCode} onChange={(e) => setDefaultOutputVatCode(e.target.value)} className={inputCls}>
            <option value="">{t('settings.accounting.vat.defaultOutputCodeNone', '— none (start at 0%) —')}</option>
            {outputVatCodes.map((c) => <option key={c.id} value={c.code}>{c.name} ({Number(c.rate).toFixed(1)}%)</option>)}
          </select>
          <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">{t('settings.accounting.vat.defaultOutputCodeHint', 'New invoices and quotes start with this VAT code selected. Existing documents are unaffected.')}</p>
        </div>
        <div>
          <label className={labelCls}>{t('settings.accounting.profileFields.vatLabel', 'VAT label (e.g. MwSt., VAT)')}</label>
          <Input value={vatLabel} onChange={(e) => setVatLabel(e.target.value)} className={inputCls} />
          <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">{t('settings.accounting.profileFields.vatLabelHint', 'Printed as the VAT-line label on invoice / quote PDFs. Leave blank to use the document language default.')}</p>
        </div>
      </CardContent></Card>

      <div>
        <Button onClick={() => save.mutate()} disabled={save.isPending}><Save className="w-4 h-4 mr-2" /> {save.isPending ? t('common.saving', 'Saving…') : t('common.save', 'Save')}</Button>
      </div>

      {/* VAT codes + rate→code / treatment→code maps — relocated here from the
          Chart-of-accounts page so all VAT config lives in one place. */}
      <VatCodesManager />

      {/* Chart of accounts (accounts + category/default-account mappings) —
          moved off the /admin/accounting section so all accounting config is
          here; the section keeps only the operational pages. */}
      <div className="pt-2">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400 mb-3">
          {t('ledger.accounts.title', 'Chart of accounts')}
        </h3>
        <ChartOfAccountsManager />
      </div>
    </div>
  );
};

export default AccountingTab;
