/**
 * Pieces the invoice and quote editors share: the "CC PDF to" field with
 * its admin picker, the Net days + Payment schedule selects and their
 * configured defaults, and the default output VAT code. The hooks only
 * return values; each editor seeds its own form state with them.
 */
import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Input } from '../common';
import { userManagementService } from '../../services/userManagement.service';
import {
  quotesService, type PaymentNetDaysTemplate, type PaymentTimingTemplate,
} from '../../services/quotes.service';
import { settingsService } from '../../services/settings.service';
import { accountingService } from '../../services/accounting.service';
import { vatCodesService } from '../../services/vatCodes.service';

/** Which editor's i18n keys to read: `bills.field.*` or `quotes.field.*`. */
type EditorNs = 'bills' | 'quotes';

/**
 * Active admins with an email, for the CC PDF picker. Falls back to an
 * empty list silently if the current user lacks users.view.
 */
export function useActiveAdmins() {
  const { data: adminUsers } = useQuery({
    queryKey: ['admin-users-list'],
    queryFn: async () => {
      try { return await userManagementService.getUsers(); } catch { return []; }
    },
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
  return useMemo(
    () => (adminUsers || []).filter((u) => u.isActive !== false && !!u.email),
    [adminUsers]
  );
}

/** CC PDF email, with a picker when more than one admin exists. */
export const CcPdfField: React.FC<{
  ns: EditorNs;
  pickerId: string;
  value: string;
  onChange: (email: string) => void;
}> = ({ ns, pickerId, value, onChange }) => {
  const { t } = useTranslation();
  const activeAdmins = useActiveAdmins();
  return (
    <div className="space-y-1">
      <Input
        type="email"
        label={t(`${ns}.field.ccPdfEmail`, 'CC PDF to (extra recipient)') as string}
        placeholder={t(`${ns}.field.ccPdfEmailPlaceholder`, 'name@example.com') as string}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {activeAdmins.length > 1 && (
        <div className="flex items-center gap-2">
          <label htmlFor={pickerId} className="text-xs text-soft whitespace-nowrap">
            {t(`${ns}.field.ccPdfPickFromAdmins`, 'Pick from admins:')}
          </label>
          <select
            id={pickerId}
            value={activeAdmins.some((a) => a.email === value) ? value : ''}
            onChange={(e) => {
              const email = e.target.value;
              if (email) onChange(email);
            }}
            className="text-xs px-2 py-1 border border-line-strong bg-panel text-heading rounded focus:ring-2 focus:ring-accent focus:border-accent-dark"
          >
            <option value="">{t(`${ns}.field.ccPdfCustom`, 'Custom email')}</option>
            {activeAdmins.map((a) => (
              <option key={a.id} value={a.email}>{a.email}</option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
};

/**
 * The Net days + Timing template lists (migration 124 split), the CRM
 * settings (loaded on new documents only), and the defaults a new
 * document starts with: configured setting → Net 30 / first timing →
 * first. `defaults` stays null on edit and until everything has loaded,
 * so the admin's configured default wins over the fallback.
 */
export function useDefaultPaymentTemplates(isEdit: boolean) {
  const { data: netDaysTemplates } = useQuery({
    queryKey: ['payment-net-days-templates'],
    queryFn: () => quotesService.listPaymentNetDaysTemplates(),
  });
  const { data: timingTemplates } = useQuery({
    queryKey: ['payment-timing-templates'],
    queryFn: () => quotesService.listPaymentTimingTemplates(),
  });
  const { data: appSettings } = useQuery({
    queryKey: ['app-settings'],
    queryFn: () => settingsService.getAllSettings(),
    enabled: !isEdit,
  });

  const defaults = useMemo(() => {
    if (isEdit) return null;
    if (!netDaysTemplates?.templates?.length || !timingTemplates?.templates?.length) return null;
    if (appSettings === undefined) return null;

    const settingNetDaysId = appSettings?.crm_invoices_default_payment_net_days_template_id;
    const settingTimingId  = appSettings?.crm_invoices_default_payment_timing_template_id;
    const settingNetDays = settingNetDaysId
      ? netDaysTemplates.templates.find((t) => t.id === settingNetDaysId)
      : null;
    const settingTiming = settingTimingId
      ? timingTemplates.templates.find((t) => t.id === settingTimingId)
      : null;

    const defaultNetDays = settingNetDays
      || netDaysTemplates.templates.find((t) => t.netDays === 30)
      || netDaysTemplates.templates[0];
    const defaultTiming = settingTiming
      || timingTemplates.templates[0];
    return { netDaysId: defaultNetDays.id, timingId: defaultTiming.id };
  }, [isEdit, netDaysTemplates, timingTemplates, appSettings]);

  return { netDaysTemplates, timingTemplates, appSettings, defaults };
}

/** The Net days and Payment schedule selects, side by side. */
export const PaymentTermSelects: React.FC<{
  ns: EditorNs;
  netDaysTemplates: PaymentNetDaysTemplate[] | undefined;
  timingTemplates: PaymentTimingTemplate[] | undefined;
  netDaysId: number | null;
  timingId: number | null;
  onNetDaysChange: (id: number | null) => void;
  onTimingChange: (id: number | null) => void;
}> = ({ ns, netDaysTemplates, timingTemplates, netDaysId, timingId, onNetDaysChange, onTimingChange }) => {
  const { t } = useTranslation();
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      <div>
        <label className="block text-sm font-medium mb-1">{t(`${ns}.field.paymentNetDays`, 'Net days')}</label>
        <select
          className="w-full px-3 py-2 rounded-md border border-line-strong bg-panel text-sm"
          value={netDaysId || ''}
          onChange={(e) => onNetDaysChange(e.target.value ? Number(e.target.value) : null)}
        >
          <option value="">{t(`${ns}.field.selectNetDays`, '— Select net days —')}</option>
          {netDaysTemplates?.map((tpl) => (
            <option key={tpl.id} value={tpl.id}>{tpl.name}</option>
          ))}
        </select>
      </div>
      <div>
        <label className="block text-sm font-medium mb-1">{t(`${ns}.field.paymentTiming`, 'Payment schedule')}</label>
        <select
          className="w-full px-3 py-2 rounded-md border border-line-strong bg-panel text-sm"
          value={timingId || ''}
          onChange={(e) => onTimingChange(e.target.value ? Number(e.target.value) : null)}
        >
          <option value="">{t(`${ns}.field.selectTiming`, '— Select schedule —')}</option>
          {timingTemplates?.map((tpl) => (
            <option key={tpl.id} value={tpl.id}>{tpl.name}</option>
          ))}
        </select>
      </div>
    </div>
  );
};

/**
 * The configured default OUTPUT VAT code (Settings → Accounting), or
 * undefined when none is set, the code list has not loaded, or
 * `enabled` is false.
 */
export function useDefaultOutputVat(enabled: boolean) {
  const { data: acctSettings } = useQuery({ queryKey: ['accounting-settings'], queryFn: () => accountingService.getSettings() });
  const { data: outputVatCodes } = useQuery({ queryKey: ['vat-codes', 'output'], queryFn: () => vatCodesService.listOutput() });
  return useMemo(() => {
    if (!enabled) return undefined;
    const code = acctSettings?.accounting_default_output_vat_code;
    if (!code || !outputVatCodes) return undefined;
    return outputVatCodes.find((c) => c.code === code);
  }, [enabled, acctSettings, outputVatCodes]);
}
