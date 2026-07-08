/**
 * Settings → Business profile tab.
 *
 * Issuer block + bank-account roster used by every quote / invoice PDF.
 * Loads via businessProfileService.get(); each section persists via the
 * matching service method.
 */
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, Star, Pencil, Save, Clock, Copy } from 'lucide-react';
import {
  businessProfileService,
  type BusinessProfile,
  type BankAccount,
  type BusinessHours,
  type BusinessHoursBlock,
  type QrFormat,
} from '../../../services/businessProfile.service';
import { Button, Card, Loading, Input, CountrySelect, TimeField } from '../../../components/common';
import { toast } from 'react-toastify';
import { currencyOptions, normalizeCurrency } from '../../../constants/currencies';
import { useMutationWithToast } from '../../../hooks';

// Full IANA timezone list for the picker. `Intl.supportedValuesOf` is ES2022
// (all current browsers); fall back to a small CH/LI-relevant set on the rare
// engine that lacks it.
const IANA_TIMEZONES: string[] = (() => {
  try {
    // @ts-expect-error supportedValuesOf is ES2022, not yet in all TS lib defs
    return Intl.supportedValuesOf('timeZone') as string[];
  } catch {
    return ['UTC', 'Europe/Vaduz', 'Europe/Zurich', 'Europe/Berlin', 'Europe/Vienna', 'Europe/Paris', 'Europe/London'];
  }
})();

export const SettingsBusinessProfilePage: React.FC = () => {
  const { t } = useTranslation();
  const { data, isLoading } = useQuery({
    queryKey: ['business-profile'],
    queryFn: () => businessProfileService.get(),
  });

  const [profile, setProfile] = useState<BusinessProfile | null>(null);
  useEffect(() => { if (data?.profile) setProfile(data.profile); }, [data]);

  const saveProfile = useMutationWithToast({
    // vatLabel + defaultHourlyRateMinor now live on Settings → Accounting, and
    // vatRateDefault is retired (the rates are the Accounting VAT codes). Strip
    // them from this save so an open Business-profile page can't clobber an edit
    // made on the Accounting tab with its stale loaded value.
    mutationFn: () => {
      if (!profile) return Promise.reject();
      const { vatLabel, defaultHourlyRateMinor, vatRateDefault, ...rest } = profile;
      void vatLabel; void defaultHourlyRateMinor; void vatRateDefault;
      return businessProfileService.update(rest);
    },
    successMessage: t('businessProfile.savedToast', 'Business profile saved.'),
    invalidateKeys: [['business-profile']],
    errorMessage: 'Save failed',
  });

  if (isLoading || !profile) return <Loading />;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold">{t('businessProfile.title', 'Business profile')}</h2>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            {t('businessProfile.subtitle', 'Issuer block shown on every quote and invoice PDF.')}
          </p>
        </div>
        <Button
          onClick={() => saveProfile.mutate()}
          disabled={saveProfile.isPending}
          isLoading={saveProfile.isPending}
          leftIcon={<Save className="w-4 h-4" />}
        >
          {t('common.save', 'Save')}
        </Button>
      </div>

      <Card>
        <h3 className="font-semibold mb-3">{t('businessProfile.section.company', 'Company')}</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Input label={t('businessProfile.field.companyName', 'Company name') as string} value={profile.companyName}
            onChange={(e) => setProfile({ ...profile, companyName: e.target.value })} />
          <Input label={t('businessProfile.field.vatId', 'VAT ID (USt-IdNr.)') as string} value={profile.vatId}
            onChange={(e) => setProfile({ ...profile, vatId: e.target.value })} />
          {/* Migration 139 — Steuernummer. Distinct from VAT-ID. §14
              UStG requires one or both on every invoice; many
              Kleinunternehmer (§19 UStG) only have this. */}
          <Input label={t('businessProfile.field.taxId', 'Tax number (Steuernummer)') as string}
            value={profile.taxId}
            onChange={(e) => setProfile({ ...profile, taxId: e.target.value })} />
          <Input label={t('businessProfile.field.addressLine1', 'Address line 1') as string} value={profile.addressLine1}
            onChange={(e) => setProfile({ ...profile, addressLine1: e.target.value })} />
          <Input label={t('businessProfile.field.addressLine2', 'Address line 2') as string} value={profile.addressLine2}
            onChange={(e) => setProfile({ ...profile, addressLine2: e.target.value })} />
          <Input label={t('businessProfile.field.postalCode', 'Postal code') as string} value={profile.postalCode}
            onChange={(e) => setProfile({ ...profile, postalCode: e.target.value })} />
          <Input label={t('businessProfile.field.city', 'City') as string} value={profile.city}
            onChange={(e) => setProfile({ ...profile, city: e.target.value })} />
          <Input label={t('businessProfile.field.state', 'State / Region') as string} value={profile.state}
            onChange={(e) => setProfile({ ...profile, state: e.target.value })} />
          <CountrySelect label={t('businessProfile.field.countryCode', 'Country') as string}
            value={profile.countryCode || ''}
            onChange={(code) => setProfile({ ...profile, countryCode: code })} />
          {/* The free-text "Country (full name)" override (migration 107) was
              removed as redundant — the picker stores the ISO code and the PDF
              renderer derives the localized full name from it
              (pdfService.countryName). The DB column + `country_name ||`
              fallback remain, so any legacy override still renders. */}
        </div>
      </Card>

      <Card>
        <h3 className="font-semibold mb-3">{t('businessProfile.section.contact', 'Contact')}</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Input label={t('businessProfile.field.phone', 'Phone') as string} value={profile.phone}
            onChange={(e) => setProfile({ ...profile, phone: e.target.value })} />
          <Input label={t('businessProfile.field.mobile', 'Mobile') as string} value={profile.mobile}
            onChange={(e) => setProfile({ ...profile, mobile: e.target.value })} />
          <Input type="email" label={t('businessProfile.field.email', 'Email') as string} value={profile.email}
            onChange={(e) => setProfile({ ...profile, email: e.target.value })} />
          <Input label={t('businessProfile.field.website', 'Website') as string} value={profile.website}
            onChange={(e) => setProfile({ ...profile, website: e.target.value })} />
        </div>
      </Card>

      <Card>
        <h3 className="font-semibold mb-3">{t('businessProfile.section.defaults', 'Defaults')}</h3>
        {/* Pointer so admins who look for the old VAT/hourly-rate fields here
            know where they went. */}
        <p className="mb-3 rounded-md border border-blue-200 dark:border-blue-900/50 bg-blue-50 dark:bg-blue-900/20 px-3 py-2 text-xs text-blue-800 dark:text-blue-300">
          {t('businessProfile.movedToAccounting', 'The VAT rate, VAT label and default hourly rate now live under Settings → Accounting.')}
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
              {t('businessProfile.field.defaultCurrency', 'Default currency')}
            </label>
            {/* Dropdown; the stored value is normalised (e.g. an old free-text
                "chf" → "CHF") so it pre-selects, and an unknown code is kept as
                an extra option so nothing is lost. */}
            <select
              value={normalizeCurrency(profile.defaultCurrency)}
              onChange={(e) => setProfile({ ...profile, defaultCurrency: e.target.value })}
              className="w-full px-3 py-2 rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
            >
              {currencyOptions(profile.defaultCurrency).map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>
          <Input label={t('businessProfile.field.defaultLocale', 'Default locale') as string} value={profile.defaultLocale}
            maxLength={8} onChange={(e) => setProfile({ ...profile, defaultLocale: e.target.value })} />
          {/* Migration 137 — IANA timezone for the admin calendar + the
              scheduled-email business-hours snapping. Dropdown of the full
              IANA list; blank = fall back to the server/browser tz. */}
          <div>
            <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
              {t('businessProfile.field.timezone', 'Timezone (IANA)')}
            </label>
            <select
              value={profile.timezone || ''}
              onChange={(e) => setProfile({ ...profile, timezone: e.target.value || null })}
              className="w-full px-3 py-2 rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
            >
              <option value="">
                {t('businessProfile.field.timezoneSystemDefault', 'System default')} ({Intl.DateTimeFormat().resolvedOptions().timeZone})
              </option>
              {IANA_TIMEZONES.map((tz) => (
                <option key={tz} value={tz}>{tz}</option>
              ))}
            </select>
          </div>
          {/* VAT rate %, VAT label and the default hourly rate moved to
              Settings → Accounting (so all financial/VAT config lives in one
              place). See the callout above. */}
          <div>
            <label className="block text-sm font-medium mb-1">{t('businessProfile.field.defaultQrFormat', 'Default invoice QR')}</label>
            <select value={profile.defaultQrFormat} onChange={(e) => setProfile({ ...profile, defaultQrFormat: e.target.value as QrFormat })}
              className="w-full px-3 py-2 rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-sm">
              <option value="none">{t('businessProfile.qrFormat.none', 'None')}</option>
              <option value="swiss">{t('businessProfile.qrFormat.swiss', 'Swiss QR-bill (CH / LI)')}</option>
              <option value="epc">{t('businessProfile.qrFormat.epc', 'EPC QR (SEPA / EUR)')}</option>
            </select>
          </div>
          <Input label={t('businessProfile.field.footerLine', 'PDF footer line') as string} value={profile.footerLine}
            onChange={(e) => setProfile({ ...profile, footerLine: e.target.value })} />
          {/* Dedicated PDF letterhead logo — separate from the global
              Settings → Branding logo. SVG accepted (rasterised to PNG
              on the fly). When unset the renderer falls back to the
              branding logo. */}
          <div className="md:col-span-2">
            <PdfLogoUploader profile={profile} setProfile={setProfile} />
          </div>
          {/* Logo banner height (pt) — admin-adjustable per migration 108. */}
          <Input type="number" min={24} max={200}
            label={t('businessProfile.field.pdfLogoHeight', 'PDF logo height (pt, 24-200)') as string}
            value={profile.pdfLogoHeight ?? 56}
            onChange={(e) => setProfile({ ...profile, pdfLogoHeight: Number(e.target.value) })} />
          {/* Folding marks dropdown. */}
          <div>
            <label className="block text-sm font-medium mb-1">
              {t('businessProfile.field.pdfFoldingMarks', 'Folding marks on PDF page edge')}
            </label>
            <select value={profile.pdfFoldingMarks || 'none'}
              onChange={(e) => setProfile({ ...profile, pdfFoldingMarks: e.target.value as any })}
              className="w-full px-3 py-2 rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-sm">
              <option value="none">{t('businessProfile.foldingMarks.none', 'None')}</option>
              <option value="half">{t('businessProfile.foldingMarks.half', 'Half (148.5mm) — for C5 envelopes')}</option>
              <option value="third">{t('businessProfile.foldingMarks.third', 'Thirds (105 + 210mm) — for DL / DIN long envelopes')}</option>
              <option value="both">{t('businessProfile.foldingMarks.both', 'All three marks')}</option>
            </select>
          </div>
          {/* PDF font selection lives on Settings → Branding now
              (migration 121, "PDF typography" card). The legacy
              free-text TTF path input was retired in favour of the
              bundled-fonts dropdown there. The column
              `pdf_font_ttf_path` stays on the row as a power-user
              override that the PDF renderer still honours when
              populated directly in the DB. */}
        </div>

        {/* PDF letterhead visibility toggles — let the admin suppress
            the logo or the company-name line independently. Useful
            when the logo itself already contains the brand name
            (very common with wordmark logos). Lifted out of the input
            grid so the toggle switches don't fight the field sizing. */}
        <div className="mt-4 pt-4 border-t border-neutral-200 dark:border-neutral-700 space-y-3">
          <PdfToggleRow
            label={t('businessProfile.field.pdfShowLogo', 'Show logo in PDF letterhead') as string}
            description={t('businessProfile.field.pdfShowLogoHelp',
              'When off, the logo image is suppressed on every PDF even if a logo is uploaded.') as string}
            enabled={profile.pdfShowLogo}
            onChange={(v) => setProfile({ ...profile, pdfShowLogo: v })}
          />
          <PdfToggleRow
            label={t('businessProfile.field.pdfShowCompanyName', 'Show company name in PDF letterhead') as string}
            description={t('businessProfile.field.pdfShowCompanyNameHelp',
              'When off, the company-name line is suppressed (useful if the logo is a wordmark already containing the name).') as string}
            enabled={profile.pdfShowCompanyName}
            onChange={(v) => setProfile({ ...profile, pdfShowCompanyName: v })}
          />
          <PdfToggleRow
            label={t('businessProfile.field.pdfCompanyNameInline', 'Render company name inline with address') as string}
            description={t('businessProfile.field.pdfCompanyNameInlineHelp',
              'When on, the company name appears as a plain line directly above the street address (same size + weight). When off, it renders as a bold title under the logo.') as string}
            enabled={profile.pdfCompanyNameInline}
            onChange={(v) => setProfile({ ...profile, pdfCompanyNameInline: v })}
          />
          {/* Quote payment-block toggles (migration 110). Both default
              OFF — a quote is an offer, not a demand for payment, and
              the IBAN block is always invoice-only. Admins opt in when
              they want to set payment expectations on the quote. */}
          <PdfToggleRow
            label={t('businessProfile.field.pdfQuoteShowNetDays', 'Show net payment days on quote PDFs') as string}
            description={t('businessProfile.field.pdfQuoteShowNetDaysHelp',
              'When on, quote PDFs include the "X days from invoice date." line in the payment conditions block. Invoices always show this row regardless.') as string}
            enabled={profile.pdfQuoteShowNetDays}
            onChange={(v) => setProfile({ ...profile, pdfQuoteShowNetDays: v })}
          />
          <PdfToggleRow
            label={t('businessProfile.field.pdfQuoteShowSkonto', 'Show Skonto / early-payment discount on quote PDFs') as string}
            description={t('businessProfile.field.pdfQuoteShowSkontoHelp',
              'When on, quote PDFs include the Skonto offer and the "Amount with discount" line. Invoices always show these regardless.') as string}
            enabled={profile.pdfQuoteShowSkonto}
            onChange={(v) => setProfile({ ...profile, pdfQuoteShowSkonto: v })}
          />
        </div>
      </Card>

      {/* Business hours (migration 114). Per-weekday opening blocks with
          lunch-break support, interpreted in the profile timezone above.
          Drives the scheduled-email floor: an email scheduled outside the
          open blocks is held until the next opening. */}
      <Card>
        <div className="flex items-center gap-2 mb-1">
          <Clock className="w-5 h-5 text-neutral-500" />
          <h3 className="font-semibold">{t('businessProfile.businessHours.title', 'Business hours')}</h3>
        </div>
        <p className="text-sm text-neutral-600 dark:text-neutral-400 mb-4">
          {t('businessProfile.businessHours.subtitle',
            'Set opening hours per weekday — add a second block for a lunch break. Interpreted in the timezone above ({{tz}}).',
            { tz: profile.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone })}
        </p>

        <BusinessHoursEditor
          value={profile.businessHours}
          onChange={(next) => setProfile({ ...profile, businessHours: next })}
        />

        <div className="mt-4 pt-4 border-t border-neutral-200 dark:border-neutral-700">
          <PdfToggleRow
            label={t('businessProfile.businessHours.floorToggle', 'Hold scheduled emails until business hours') as string}
            description={t('businessProfile.businessHours.floorToggleHelp',
              'When on, an automated email scheduled outside the hours above is delivered at the next opening instead of at an odd hour. When off, scheduled emails send at their exact time.') as string}
            enabled={profile.scheduledEmailFloorEnabled}
            onChange={(v) => setProfile({ ...profile, scheduledEmailFloorEnabled: v })}
          />
        </div>
      </Card>

      {/* Disclaimer banner for QR-bill / IBAN data. picpeak renders
          what the operator types — it cannot validate IBAN/BIC, QR-IID
          or scan-compatibility with any specific bank's e-banking app.
          See docs/crm-disclaimers.md. */}
      <div className="mt-4 p-3 rounded-md border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 text-sm text-amber-900 dark:text-amber-200">
        <p className="font-medium mb-1">
          {t('businessProfile.qrDisclaimer.title', 'QR-bill / bank data — verify before going live')}
        </p>
        <p className="text-xs">
          {t(
            'businessProfile.qrDisclaimer.body',
            "Picpeak is open source. We render the QR code and IBAN block from the values you typed — we don't validate them. Print a test invoice and scan it with your bank's app before sending real invoices. We are not responsible for any mistakes that come from sending an invoice with bad data on it.",
          )}
        </p>
      </div>

      <BankAccountsSection accounts={data?.bankAccounts ?? []} />
    </div>
  );
};

/**
 * Toggle row used for the PDF letterhead visibility options. Same
 * accessible-switch markup as the customer feature toggles on
 * CustomerDetailPage so the styling is consistent across the admin.
 */
interface PdfToggleRowProps {
  label: string;
  description?: string;
  enabled: boolean;
  onChange: (next: boolean) => void;
}

const PdfToggleRow: React.FC<PdfToggleRowProps> = ({ label, description, enabled, onChange }) => (
  <label className="flex items-center justify-between gap-4 cursor-pointer">
    <span className="text-sm">
      <span className="font-medium text-neutral-900 dark:text-neutral-100">{label}</span>
      {description && (
        <span className="block text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">{description}</span>
      )}
    </span>
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      onClick={() => onChange(!enabled)}
      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 shrink-0 ${enabled ? '' : 'bg-neutral-300 dark:bg-neutral-600'}`}
      style={enabled ? { backgroundColor: 'var(--color-accent)' } : undefined}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${enabled ? 'translate-x-6' : 'translate-x-1'}`}
      />
    </button>
  </label>
);

/**
 * Per-weekday business-hours editor (migration 114). Google-style: each
 * weekday holds zero or more {start,end} blocks, so a day can be closed
 * (no blocks), open all day (one block), or have a lunch break (two).
 * Edits the parent's `businessHours` object directly; the page-level Save
 * persists it. ISO weekday keys "1".."7" (1=Mon … 7=Sun).
 */
const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7];

const BusinessHoursEditor: React.FC<{
  value: BusinessHours | null;
  onChange: (next: BusinessHours) => void;
}> = ({ value, onChange }) => {
  const { t } = useTranslation();

  // Always work with a fully-populated 7-day object so toggling a day on
  // and off doesn't drop sibling keys.
  const full: BusinessHours = {};
  for (const iso of WEEKDAYS) {
    const blocks = value?.[String(iso)];
    full[String(iso)] = Array.isArray(blocks) ? blocks : [];
  }

  const setDay = (iso: number, blocks: BusinessHoursBlock[]) => {
    onChange({ ...full, [String(iso)]: blocks });
  };

  const addBlock = (iso: number) => {
    const blocks = full[String(iso)];
    // First block defaults to a full workday; a second one defaults to a
    // post-lunch afternoon so the common 09–12 / 13–18 split is one click.
    const next: BusinessHoursBlock = blocks.length === 0
      ? { start: '09:00', end: '17:00' }
      : { start: '13:00', end: '18:00' };
    setDay(iso, [...blocks, next]);
  };

  const updateBlock = (iso: number, idx: number, patch: Partial<BusinessHoursBlock>) => {
    setDay(iso, full[String(iso)].map((b, i) => (i === idx ? { ...b, ...patch } : b)));
  };

  const removeBlock = (iso: number, idx: number) => {
    setDay(iso, full[String(iso)].filter((_, i) => i !== idx));
  };

  const copyToAll = (iso: number) => {
    const src = full[String(iso)];
    const next: BusinessHours = {};
    for (const d of WEEKDAYS) next[String(d)] = src.map((b) => ({ ...b }));
    onChange(next);
  };

  return (
    <div className="space-y-2">
      {WEEKDAYS.map((iso) => {
        const blocks = full[String(iso)];
        const isOpen = blocks.length > 0;
        return (
          <div
            key={iso}
            className="flex flex-col sm:flex-row sm:items-start gap-2 sm:gap-3 py-2 border-b border-neutral-100 dark:border-neutral-800 last:border-0"
          >
            <div className="w-28 shrink-0 pt-2 text-sm font-medium text-neutral-900 dark:text-neutral-100">
              {t(`businessProfile.businessHours.weekday.${iso}`)}
            </div>

            <div className="flex-1 space-y-2">
              {!isOpen && (
                <div className="flex items-center gap-3">
                  <span className="text-sm text-neutral-500 dark:text-neutral-400">
                    {t('businessProfile.businessHours.closed', 'Closed')}
                  </span>
                  <button
                    type="button"
                    onClick={() => addBlock(iso)}
                    className="inline-flex items-center gap-1 text-sm text-primary-600 hover:text-primary-700"
                  >
                    <Plus className="w-4 h-4" />
                    {t('businessProfile.businessHours.addHours', 'Add hours')}
                  </button>
                </div>
              )}

              {blocks.map((block, idx) => (
                <div key={idx} className="flex items-center gap-2">
                  <TimeField
                    value={block.start}
                    onChange={(v) => updateBlock(iso, idx, { start: v })}
                    ariaLabel={t('businessProfile.businessHours.startTime', 'Opening time') as string}
                    className="w-32 shrink-0"
                  />
                  <span className="text-neutral-400">–</span>
                  <TimeField
                    value={block.end}
                    onChange={(v) => updateBlock(iso, idx, { end: v })}
                    ariaLabel={t('businessProfile.businessHours.endTime', 'Closing time') as string}
                    className="w-32 shrink-0"
                  />
                  <button
                    type="button"
                    onClick={() => removeBlock(iso, idx)}
                    aria-label={t('common.remove', 'Remove') as string}
                    className="p-1.5 text-neutral-400 hover:text-red-600"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                  {idx === blocks.length - 1 && (
                    <button
                      type="button"
                      onClick={() => addBlock(iso)}
                      aria-label={t('businessProfile.businessHours.addBlock', 'Add another block') as string}
                      className="p-1.5 text-primary-600 hover:text-primary-700"
                    >
                      <Plus className="w-4 h-4" />
                    </button>
                  )}
                </div>
              ))}
            </div>

            {isOpen && (
              <button
                type="button"
                onClick={() => copyToAll(iso)}
                className="shrink-0 inline-flex items-center gap-1 pt-2 text-xs text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300"
              >
                <Copy className="w-3.5 h-3.5" />
                {t('businessProfile.businessHours.copyToAll', 'Copy to all days')}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
};

/**
 * Dedicated PDF letterhead logo uploader. Accepts PNG / JPEG / SVG;
 * the backend rasterises SVG to PNG via sharp so vector uploads work
 * in print. Stores the relative path on business_profile.logo_path.
 */
interface PdfLogoUploaderProps {
  profile: BusinessProfile;
  setProfile: (next: BusinessProfile) => void;
}
const PdfLogoUploader: React.FC<PdfLogoUploaderProps> = ({ profile, setProfile }) => {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [uploading, setUploading] = useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const onPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const { logoPath } = await businessProfileService.uploadLogo(file);
      setProfile({ ...profile, logoPath });
      qc.invalidateQueries({ queryKey: ['business-profile'] });
      toast.success(t('businessProfile.logoUploadedToast', 'PDF logo uploaded.'));
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Upload failed');
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const onClear = async () => {
    if (!window.confirm(t('businessProfile.logoConfirmClear', 'Remove the PDF logo? The renderer will fall back to the Branding logo if one is set.'))) return;
    setUploading(true);
    try {
      await businessProfileService.clearLogo();
      setProfile({ ...profile, logoPath: '' });
      qc.invalidateQueries({ queryKey: ['business-profile'] });
      toast.success(t('businessProfile.logoClearedToast', 'PDF logo removed.'));
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Clear failed');
    } finally {
      setUploading(false);
    }
  };

  return (
    <div>
      <label className="block text-sm font-medium mb-1">
        {t('businessProfile.field.pdfLogoUpload', 'PDF letterhead logo (PNG, JPEG, or SVG)')}
      </label>
      <div className="flex items-center gap-3 flex-wrap">
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/svg+xml"
          onChange={onPick}
          disabled={uploading}
          className="text-sm file:mr-3 file:rounded-md file:border-0 file:bg-primary-600 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-white hover:file:bg-primary-700 disabled:opacity-60"
        />
        {profile.logoPath && (
          <>
            <span className="text-xs text-neutral-500 font-mono break-all">{profile.logoPath}</span>
            <Button variant="outline" size="sm" onClick={onClear} disabled={uploading}>
              {t('common.remove', 'Remove')}
            </Button>
          </>
        )}
      </div>
      <p className="text-xs text-neutral-500 mt-1">
        {t('businessProfile.field.pdfLogoUploadHelp',
          'Used on every quote and invoice PDF. SVG is accepted and rasterised to PNG automatically. When empty, the renderer falls back to the global Branding logo.')}
      </p>
    </div>
  );
};

interface BankAccountsSectionProps { accounts: BankAccount[] }

type BankDraft = {
  label: string;
  accountHolder: string;
  iban: string;
  bic: string;
  currency: string;
  isDefault: boolean;
};

const EMPTY_DRAFT: BankDraft = {
  label: '', accountHolder: '', iban: '', bic: '', currency: 'CHF', isDefault: false,
};

const BankAccountsSection: React.FC<BankAccountsSectionProps> = ({ accounts }) => {
  const { t } = useTranslation();
  const qc = useQueryClient();
  // null = no form open; 'new' = adding; numeric id = editing that row.
  // Single piece of state means only one form is open at a time, which
  // is what the maintainer asked for: Add OR Edit, never both.
  const [openForm, setOpenForm] = useState<null | 'new' | number>(null);
  const [draft, setDraft] = useState<BankDraft>(EMPTY_DRAFT);

  const startEdit = (a: BankAccount) => {
    setDraft({
      label: a.label || '',
      accountHolder: a.accountHolder || '',
      iban: a.iban || '',
      bic: a.bic || '',
      currency: a.currency || 'CHF',
      isDefault: !!a.isDefault,
    });
    setOpenForm(a.id);
  };
  const closeForm = () => { setOpenForm(null); setDraft(EMPTY_DRAFT); };

  const create = useMutationWithToast({
    mutationFn: () => businessProfileService.createBankAccount(draft),
    successMessage: t('businessProfile.bankCreatedToast', 'Bank account added.'),
    invalidateKeys: [['business-profile']],
    errorMessage: 'Failed',
    onSuccess: () => closeForm(),
  });

  const update = useMutationWithToast({
    mutationFn: (id: number) => businessProfileService.updateBankAccount(id, draft),
    successMessage: t('businessProfile.bankUpdatedToast', 'Bank account updated.'),
    invalidateKeys: [['business-profile']],
    errorMessage: 'Failed',
    onSuccess: () => closeForm(),
  });

  const setDefault = useMutation({
    mutationFn: (id: number) => businessProfileService.updateBankAccount(id, { isDefault: true }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['business-profile'] }),
  });

  const remove = useMutation({
    mutationFn: (id: number) => businessProfileService.deleteBankAccount(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['business-profile'] });
      toast.success(t('businessProfile.bankDeletedToast', 'Bank account removed.'));
    },
  });

  // Form body reused for both Add and Edit (single source of layout).
  const renderForm = (mode: 'new' | 'edit', onSubmit: () => void, submitting: boolean) => (
    <div className="mb-4 p-3 rounded-md border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Input label={t('businessProfile.bank.label', 'Label') as string} value={draft.label}
          onChange={(e) => setDraft({ ...draft, label: e.target.value })} />
        <Input label={t('businessProfile.bank.accountHolder', 'Account holder') as string} value={draft.accountHolder}
          onChange={(e) => setDraft({ ...draft, accountHolder: e.target.value })} />
        <Input label="IBAN" value={draft.iban}
          onChange={(e) => setDraft({ ...draft, iban: e.target.value })} />
        <Input label="BIC" value={draft.bic}
          onChange={(e) => setDraft({ ...draft, bic: e.target.value })} />
        <Input label={t('businessProfile.bank.currency', 'Currency') as string} value={draft.currency}
          maxLength={3} onChange={(e) => setDraft({ ...draft, currency: e.target.value.toUpperCase() })} />
        <label className="flex items-center gap-2 text-sm pt-6">
          <input type="checkbox" checked={draft.isDefault}
            onChange={(e) => setDraft({ ...draft, isDefault: e.target.checked })} />
          {t('businessProfile.bank.isDefault', 'Default for this currency')}
        </label>
      </div>
      <div className="flex justify-end gap-2 mt-3">
        <Button variant="outline" size="sm" onClick={closeForm}>{t('common.cancel', 'Cancel')}</Button>
        <Button
          size="sm"
          onClick={onSubmit}
          disabled={!draft.iban || submitting}
          isLoading={submitting}
          leftIcon={mode === 'new' ? <Plus className="w-4 h-4" /> : <Save className="w-4 h-4" />}
        >
          {mode === 'new' ? t('common.add', 'Add') : t('common.save', 'Save')}
        </Button>
      </div>
    </div>
  );

  return (
    <Card>
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold">{t('businessProfile.section.banks', 'Bank accounts')}</h3>
        <Button size="sm" onClick={() => {
          if (openForm === 'new') closeForm();
          else { setDraft(EMPTY_DRAFT); setOpenForm('new'); }
        }}>
          <Plus className="w-4 h-4 mr-1" />{t('businessProfile.addBank', 'Add account')}
        </Button>
      </div>

      {openForm === 'new' && renderForm('new', () => create.mutate(), create.isPending)}

      {accounts.length === 0 ? (
        <p className="text-sm text-neutral-500">{t('businessProfile.noBanks', 'No bank accounts configured yet.')}</p>
      ) : (
        <ul className="divide-y divide-neutral-200 dark:divide-neutral-700">
          {accounts.map((b) => (
            <React.Fragment key={b.id}>
              <li className="py-2 flex items-center justify-between">
                <div>
                  <div className="font-medium text-sm">{b.label || b.iban}
                    {b.isDefault && <Star className="inline w-4 h-4 ml-1 text-amber-500" />}
                  </div>
                  <div className="text-xs text-neutral-500 font-mono">{b.iban.replace(/(.{4})/g, '$1 ').trim()}{b.currency ? ` · ${b.currency}` : ''}</div>
                </div>
                <div className="flex gap-2">
                  {!b.isDefault && (
                    <Button variant="outline" size="sm" onClick={() => setDefault.mutate(b.id)}>
                      {t('businessProfile.bank.makeDefault', 'Make default')}
                    </Button>
                  )}
                  <Button variant="outline" size="sm" onClick={() => {
                    if (openForm === b.id) closeForm();
                    else startEdit(b);
                  }}
                    title={t('common.edit', 'Edit') as string}>
                    <Pencil className="w-4 h-4" />
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => {
                    if (window.confirm(t('businessProfile.bank.confirmDelete', 'Remove this bank account?'))) remove.mutate(b.id);
                  }}
                    title={t('common.delete', 'Delete') as string}>
                    <Trash2 className="w-4 h-4 text-red-600" />
                  </Button>
                </div>
              </li>
              {openForm === b.id && (
                <li className="py-2">
                  {renderForm('edit', () => update.mutate(b.id), update.isPending)}
                </li>
              )}
            </React.Fragment>
          ))}
        </ul>
      )}
    </Card>
  );
};
