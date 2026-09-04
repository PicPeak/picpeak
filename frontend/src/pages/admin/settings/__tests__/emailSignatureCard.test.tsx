/**
 * Settings → Business profile — email signature card (migration 198, #1264).
 *
 * The preview here mirrors the backend's `renderEmailSignature`, so the
 * cases worth pinning are the ones where the two could silently drift:
 * the "LI-9494 Schaan / Liechtenstein" city line, the middle-dot joins,
 * and the omit-when-empty rule. Plus the two states an operator can land
 * in and misread — signature off, and signature on with a blank profile.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import type { BusinessProfile } from '../../../../services/businessProfile.service';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({
      t: (k: string, fb?: unknown) => (typeof fb === 'string' ? fb : k),
      i18n: { language: 'en' },
    }),
  };
});

vi.mock('react-toastify', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const baseProfile: BusinessProfile = {
  id: 1,
  companyName: 'Müller Fotografie GmbH',
  addressLine1: 'Bahnhofstrasse 1',
  addressLine2: '',
  postalCode: '9494',
  city: 'Schaan',
  state: '',
  countryCode: 'LI',
  countryName: 'Liechtenstein',
  phone: '+41 79 123 45 67',
  mobile: '',
  email: 'hello@example.com',
  website: 'example.com',
  vatId: 'CHE-123.456.789',
  taxId: '',
  vatLabel: 'MwSt.',
  vatRateDefault: null,
  defaultHourlyRateMinor: null,
  defaultCurrency: 'CHF',
  defaultLocale: 'de',
  defaultQrFormat: 'none',
  footerLine: '',
  logoPath: '',
  pdfFontTtfPath: '',
  pdfFontFamily: null,
  pdfShowLogo: true,
  pdfShowCompanyName: true,
  pdfCompanyNameInline: false,
  pdfLogoHeight: 56,
  pdfFoldingMarks: 'none',
  pdfQuoteShowNetDays: false,
  pdfQuoteShowSkonto: false,
  timezone: null,
  businessHours: null,
  scheduledEmailFloorEnabled: true,
  emailSignatureEnabled: true,
  emailSignatureExtra: 'Handelsregister Vaduz',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

let profileFixture: BusinessProfile = baseProfile;

vi.mock('../../../../services/businessProfile.service', () => ({
  businessProfileService: {
    get: vi.fn(async () => ({ profile: profileFixture, bankAccounts: [] })),
    update: vi.fn(async () => ({ profile: profileFixture, bankAccounts: [] })),
    listBankAccounts: vi.fn(async () => ({ bankAccounts: [] })),
    createBankAccount: vi.fn(),
    updateBankAccount: vi.fn(),
    deleteBankAccount: vi.fn(),
    uploadLogo: vi.fn(),
    clearLogo: vi.fn(),
  },
}));

import { SettingsBusinessProfilePage } from '../SettingsBusinessProfilePage';

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <SettingsBusinessProfilePage />
    </QueryClientProvider>
  );
}

describe('email signature card', () => {
  beforeEach(() => {
    profileFixture = { ...baseProfile };
  });

  it('renders the signature preview from the address fields above', async () => {
    renderPage();

    // Scoped to the preview block — the legal line also lives in the
    // textarea above it, and the company name in the form fields.
    const preview = within(await screen.findByTestId('email-signature-preview'));

    expect(preview.getByText('Müller Fotografie GmbH')).toBeInTheDocument();
    // City line uses the PDF issuer shape, not a raw "9494 Schaan".
    expect(preview.getByText('Bahnhofstrasse 1 · LI-9494 Schaan / Liechtenstein')).toBeInTheDocument();
    // Empty mobile is omitted rather than producing a doubled separator.
    expect(preview.getByText('+41 79 123 45 67 · hello@example.com · example.com')).toBeInTheDocument();
    expect(preview.getByText('VAT ID: CHE-123.456.789')).toBeInTheDocument();
    expect(preview.getByText('Handelsregister Vaduz')).toBeInTheDocument();
  });

  it('explains the off state instead of showing a stale preview', async () => {
    profileFixture = { ...baseProfile, emailSignatureEnabled: false };
    renderPage();

    expect(
      await screen.findByText('Signature is off — emails show the logo and company name only.')
    ).toBeInTheDocument();
    expect(screen.queryByTestId('email-signature-preview')).not.toBeInTheDocument();
  });

  it('warns when the signature is on but every field is blank', async () => {
    profileFixture = {
      ...baseProfile,
      companyName: '', addressLine1: '', addressLine2: '', postalCode: '', city: '',
      countryCode: '', countryName: '', phone: '', mobile: '', email: '', website: '',
      vatId: '', emailSignatureExtra: '',
    };
    renderPage();

    expect(
      await screen.findByText(
        'Signature is on but every field above is blank — nothing will be added to the footer.'
      )
    ).toBeInTheDocument();
  });

  it('toggling off updates the preview without a save', async () => {
    renderPage();
    await screen.findByText('Footer preview');

    await userEvent.click(screen.getByRole('switch', { name: /Show signature in email footers/i }));

    expect(
      screen.getByText('Signature is off — emails show the logo and company name only.')
    ).toBeInTheDocument();
  });

  it('caps the legal line at 500 characters', async () => {
    renderPage();

    const textarea = (await screen.findByPlaceholderText(
      'Handelsregister Vaduz FL-0002.123.456-7'
    )) as HTMLTextAreaElement;
    expect(textarea.maxLength).toBe(500);
  });
});
