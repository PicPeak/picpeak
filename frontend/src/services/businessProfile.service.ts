/**
 * Admin → Business profile API client.
 *
 * Backs the Settings → Business profile tab. Issuer block + bank account
 * roster used to render every quote / invoice PDF.
 */
import { api } from '../config/api';

export type QrFormat = 'swiss' | 'epc' | 'none';

export interface BusinessProfile {
  id: number;
  companyName: string;
  addressLine1: string;
  addressLine2: string;
  postalCode: string;
  city: string;
  state: string;
  countryCode: string;
  /** Free-text country name (migration 107). When set, the PDF
   *  renderer uses this verbatim; otherwise falls back to the
   *  locale-aware lookup on countryCode. Useful when countryCode
   *  carries the postal/vehicle abbreviation ("FL") rather than the
   *  ISO code ("LI"). */
  countryName: string;
  phone: string;
  mobile: string;
  email: string;
  website: string;
  vatId: string;
  /** Local tax number (Steuernummer in DE/AT). Distinct from vatId
   *  (USt-IdNr.); §14 UStG accepts either on invoices, and the issuer
   *  block on every PDF renders both when present. Migration 139. */
  taxId: string;
  vatLabel: string;
  vatRateDefault: number | null;
  /** Install-wide fallback hourly rate in MINOR units (migration 113).
   *  Last link in the hour-entry rate chain after the per-entry
   *  override and the per-customer default. null = no global default;
   *  the hours page then requires a per-customer or per-entry rate. */
  defaultHourlyRateMinor: number | null;
  defaultCurrency: string;
  defaultLocale: string;
  defaultQrFormat: QrFormat;
  footerLine: string;
  logoPath: string;
  /** Path (absolute or relative to storage/) to a TTF/OTF used by the
   *  PDF renderer. Falls back to Helvetica when blank or missing.
   *  The UI for setting this was retired in favour of `pdfFontFamily`
   *  (migration 121) but the field stays read-only on the type so
   *  legacy values keep flowing through. */
  pdfFontTtfPath: string;
  /** Bundled-fonts dropdown choice (migration 121). Stores the
   *  on-disk directory name under backend/assets/fonts/ (e.g.
   *  "Inter", "Playfair-Display"). null = no preference, Helvetica
   *  fallback. */
  pdfFontFamily: string | null;
  /** When false, the issuer logo image is suppressed on every PDF
   *  (even if logoPath is set). Migration 106; defaults true. */
  pdfShowLogo: boolean;
  /** When false, the company name line is suppressed in the issuer
   *  block on every PDF. Migration 106; defaults true. */
  pdfShowCompanyName: boolean;
  /** When true, the company name renders as a plain address line
   *  (same size + weight as the street) right above the address
   *  instead of as a bold title under the logo. Migration 108. */
  pdfCompanyNameInline: boolean;
  /** Logo banner height in PDF points. 24-200. Defaults to 56.
   *  Migration 108. */
  pdfLogoHeight: number;
  /** DIN 5008 folding marks on the page edge.
   *  'none' (default) | 'half' | 'third' | 'both'. Migration 108. */
  pdfFoldingMarks: 'none' | 'half' | 'third' | 'both';
  /** When true, render the "X days from invoice date." line in the
   *  payment-conditions block of QUOTE PDFs. Invoices always show
   *  this row regardless. Migration 110; defaults FALSE. */
  pdfQuoteShowNetDays: boolean;
  /** When true, render the Skonto offer + "Amount with discount"
   *  lines in the payment-conditions block of QUOTE PDFs. Invoices
   *  always show these regardless. Migration 110; defaults FALSE. */
  pdfQuoteShowSkonto: boolean;
  /** IANA timezone string for the admin calendar (e.g. "Europe/Zurich",
   *  "America/New_York"). Migration 137. Admin-only — never exposed
   *  via publicSettings. When null/empty, the calendar UI falls back
   *  to the browser's `Intl.DateTimeFormat().resolvedOptions().timeZone`. */
  timezone: string | null;
  /** Per-ISO-weekday opening hours (migration 114). Keyed "1".."7"
   *  (1=Mon … 7=Sun); each value is a list of {start,end} "HH:MM" blocks,
   *  so a day can carry a lunch break or differ from its neighbours. A day
   *  with no blocks is closed. null = no hours configured. Interpreted in
   *  `timezone`. Drives the scheduled-email business-hours floor. */
  businessHours: BusinessHours | null;
  /** Master switch for the scheduled-email business-hours floor
   *  (migration 114). Defaults true. When off, scheduled emails send at
   *  their requested instant regardless of `businessHours`. */
  scheduledEmailFloorEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface BusinessHoursBlock {
  start: string; // "HH:MM"
  end: string;   // "HH:MM"
}

/** ISO-weekday-keyed ("1".."7") opening blocks. */
export type BusinessHours = Record<string, BusinessHoursBlock[]>;

export interface BankAccount {
  id: number;
  label: string;
  accountHolder: string;
  iban: string;
  bic: string;
  currency: string;
  isDefault: boolean;
  displayOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface BusinessProfileSnapshot {
  profile: BusinessProfile;
  bankAccounts: BankAccount[];
}

export type BusinessProfilePatch = Partial<Omit<BusinessProfile, 'id' | 'createdAt' | 'updatedAt'>>;
export type BankAccountPatch = Partial<Omit<BankAccount, 'id' | 'createdAt' | 'updatedAt'>>;

export const businessProfileService = {
  async get(): Promise<BusinessProfileSnapshot> {
    const { data } = await api.get('/admin/business-profile');
    return data.data || data;
  },

  async update(payload: BusinessProfilePatch): Promise<BusinessProfileSnapshot> {
    const { data } = await api.put('/admin/business-profile', payload);
    return data.data || data;
  },

  async listBankAccounts(): Promise<{ bankAccounts: BankAccount[] }> {
    const { data } = await api.get('/admin/business-profile/bank-accounts');
    return data.data || data;
  },

  async createBankAccount(payload: BankAccountPatch & { iban: string }): Promise<{ bankAccount: BankAccount }> {
    const { data } = await api.post('/admin/business-profile/bank-accounts', payload);
    return data.data || data;
  },

  async updateBankAccount(id: number, payload: BankAccountPatch): Promise<{ bankAccount: BankAccount }> {
    const { data } = await api.put(`/admin/business-profile/bank-accounts/${id}`, payload);
    return data.data || data;
  },

  async deleteBankAccount(id: number): Promise<{ deleted: true }> {
    const { data } = await api.delete(`/admin/business-profile/bank-accounts/${id}`);
    return data.data || data;
  },

  /**
   * Upload a dedicated PDF letterhead logo. Accepts PNG, JPEG, and
   * SVG — the renderer rasterises SVG to PNG via sharp.
   */
  async uploadLogo(file: File): Promise<{ logoPath: string }> {
    const form = new FormData();
    form.append('logo', file);
    const { data } = await api.post('/admin/business-profile/logo', form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    return data.data || data;
  },

  /** Clear the dedicated PDF logo. The renderer then falls back to
   *  the global branding logo (Settings → Branding). */
  async clearLogo(): Promise<{ cleared: true }> {
    const { data } = await api.delete('/admin/business-profile/logo');
    return data.data || data;
  },
};
