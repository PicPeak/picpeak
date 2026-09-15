/**
 * Public signing page, signatures v2 (#1446).
 *
 * A v2 link: confirm the email with a code → read the contract → sign →
 * thank-you. A link from before v2 (invite answers 404) runs the old
 * single-link flow; a replaced/expired link says so; a stored session skips
 * the code, and an ended one goes back to the code step.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// Resolve against the real en.json so a missing key shows up as a failure.
vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  const en = (await import('../../../i18n/locales/en.json')).default as Record<string, unknown>;
  const lookup = (key: string): string | undefined =>
    key.split('.').reduce<unknown>(
      (node, part) => (node && typeof node === 'object'
        ? (node as Record<string, unknown>)[part] : undefined),
      en,
    ) as string | undefined;
  return {
    ...actual,
    useTranslation: () => ({
      t: (k: string, fb?: unknown, opts?: Record<string, unknown>) => {
        const base = lookup(k) ?? (typeof fb === 'string' ? fb : k);
        const vars = (typeof fb === 'object' && fb ? fb : opts) as Record<string, unknown> | undefined;
        if (!vars) return base;
        return base.replace(/\{\{(\w+)\}\}/g, (_m, key) => String(vars[key] ?? ''));
      },
      i18n: { language: 'en', changeLanguage: vi.fn(async () => undefined) },
    }),
  };
});

vi.mock('../../../hooks/usePublicDarkMode', () => ({ usePublicDarkMode: () => ({ isDark: false }) }));
vi.mock('../../../hooks/useLocalizedDate', () => ({
  useLocalizedDate: () => ({
    format: (d: string) => String(d),
    formatDateTime: (d: string) => `at ${String(d)}`,
    formatTime: (d: string) => String(d),
  }),
}));
// jsdom has no canvas; the pad is only exercised for its API here.
vi.mock('signature_pad', () => ({
  default: class {
    clear() { /* no-op */ }
    isEmpty() { return true; }
    off() { /* no-op */ }
    addEventListener() { /* no-op */ }
    removeEventListener() { /* no-op */ }
    toDataURL() { return 'data:image/png;base64,AAAA'; }
  },
}));

const invite = vi.fn();
const requestCode = vi.fn();
const verify = vi.fn();
const session = vi.fn();
const sign = vi.fn();
vi.mock('../../../services/publicContractSigning.service', async () => {
  const actual = await vi.importActual<typeof import('../../../services/publicContractSigning.service')>(
    '../../../services/publicContractSigning.service',
  );
  return {
    ...actual,
    publicContractSigningService: {
      invite: (...args: unknown[]) => invite(...args),
      requestCode: (...args: unknown[]) => requestCode(...args),
      verify: (...args: unknown[]) => verify(...args),
      session: (...args: unknown[]) => session(...args),
      sign: (...args: unknown[]) => sign(...args),
      pdf: vi.fn(),
      attachment: vi.fn(),
      decline: vi.fn(),
      uploadSignedPdf: vi.fn(),
    },
  };
});

const legacyGet = vi.fn();
vi.mock('../../../services/contracts.service', async () => {
  const actual = await vi.importActual<typeof import('../../../services/contracts.service')>(
    '../../../services/contracts.service',
  );
  return {
    ...actual,
    publicContractsService: {
      get: (...args: unknown[]) => legacyGet(...args),
      sign: vi.fn(),
      uploadSignedPdf: vi.fn(),
    },
  };
});

import { ContractResponsePage, ContractSigningSessionPage } from '../ContractResponsePage';

const TOKEN = 'a'.repeat(64);
const SESSION_TOKEN = 'b'.repeat(64);
const httpError = (status: number, data: Record<string, unknown>) => Object.assign(
  new Error(`Request failed with status code ${status}`),
  { isAxiosError: true, response: { status, data } },
);

const inviteSummary = {
  contractNumber: 'V-2026-0007',
  status: 'sent',
  language: 'en',
  issuer: { companyName: 'Studio Licht', logoUrl: null, logoUrlDark: null },
  signer: { status: 'invited', maskedEmail: 'an***@example.com' },
};

const baseContract = {
  contractNumber: 'V-2026-0007',
  status: 'sent',
  language: 'en',
  issueDate: '2026-09-01',
  validUntil: null,
  title: 'Wedding contract',
  introText: null,
  outroText: null,
  sentAt: '2026-09-01T09:00:00Z',
  signedByCustomerAt: null,
  signedByAdminAt: null,
  signedCustomerName: null,
  signedAdminName: null,
  hasSignedPdf: false,
  pdfSha256: null,
  signedPdfSha256: null,
  canSign: true,
  sections: [{
    section: 'basics',
    blocks: [{ blockId: 1, section: 'basics', position: 1, name: 'Parties', body: 'Between the studio and the couple.' }],
  }],
  recipient: null,
  issuer: {
    companyName: 'Studio Licht', addressLine1: null, postalCode: null, city: null,
    email: null, website: null, logoUrl: null, logoUrlDark: null,
  },
  attachments: [],
  allowPdfUpload: false,
  requireDrawnSignature: false,
};

const signingState = {
  name: 'Anna Muster',
  email: 'anna@example.com',
  status: 'invited',
  verifiedVia: 'otp',
  order: 'sequential',
  canSign: true,
  waitingForOthers: false,
  canDecline: true,
  signers: [
    { position: 1, role: 'customer', name: 'Anna Muster', status: 'pending' },
    { position: 2, role: 'customer', name: 'Ben Muster', status: 'pending' },
    { position: 3, role: 'issuer', name: 'Studio Licht', status: 'pending' },
  ],
};

const sessionView = (signing: Record<string, unknown> = {}) => ({
  contract: { ...baseContract, signing: { ...signingState, ...signing } },
});

function renderAt(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/contract/signing" element={<ContractSigningSessionPage />} />
          <Route path="/contract/:token" element={<ContractResponsePage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeAll(() => {
  // jsdom logs "not implemented" for canvas contexts; the page tolerates null.
  HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
});

beforeEach(() => {
  vi.clearAllMocks();
  window.sessionStorage.clear();
  invite.mockResolvedValue(inviteSummary);
  requestCode.mockResolvedValue({ maskedEmail: 'an***@example.com', ttlMinutes: 10 });
  verify.mockResolvedValue({ sessionToken: SESSION_TOKEN, expiresAt: '2099-01-01T00:00:00.000Z' });
});

it('confirms the email, shows the contract, signs with the typed name and thanks the signer', async () => {
  const user = userEvent.setup();
  session
    .mockResolvedValueOnce(sessionView())
    .mockResolvedValue(sessionView({
      status: 'signed',
      canSign: false,
      canDecline: false,
      signers: [
        { position: 1, role: 'customer', name: 'Anna Muster', status: 'signed' },
        { position: 2, role: 'customer', name: 'Ben Muster', status: 'pending' },
        { position: 3, role: 'issuer', name: 'Studio Licht', status: 'pending' },
      ],
    }));
  sign.mockResolvedValue({ status: 'sent', signedAt: '2026-09-14T10:00:00Z' });
  renderAt(`/contract/${TOKEN}`);

  // Verify step: issuer, contract number, masked email.
  expect(await screen.findByText('Contract V-2026-0007')).toBeInTheDocument();
  expect(screen.getByText('Studio Licht has asked you to sign this contract.')).toBeInTheDocument();
  expect(invite).toHaveBeenCalledWith(TOKEN);
  expect(session).not.toHaveBeenCalled();

  await user.click(screen.getByRole('button', { name: 'Send code' }));
  await user.type(await screen.findByLabelText('Six-digit code'), '123456');
  await user.click(screen.getByRole('button', { name: 'Confirm code' }));

  // Review: the contract, who signs, in which order.
  expect(await screen.findByRole('heading', { name: 'Wedding contract' })).toBeInTheDocument();
  expect(session).toHaveBeenCalledWith(SESSION_TOKEN);
  expect(JSON.parse(window.sessionStorage.getItem(`picpeak.contractSigning.session.${TOKEN}`) as string))
    .toEqual({ sessionToken: SESSION_TOKEN, expiresAt: '2099-01-01T00:00:00.000Z' });
  expect(screen.getByText('Between the studio and the couple.')).toBeInTheDocument();
  expect(screen.getByText('Ben Muster')).toBeInTheDocument();
  expect(screen.getByText('Signers sign one after the other, in this order.')).toBeInTheDocument();

  // Sign: name prefilled, consent not pre-ticked.
  expect(screen.getByLabelText('Your full name')).toHaveValue('Anna Muster');
  const consent = screen.getByRole('checkbox', { name: /I have read this contract/ });
  expect(consent).not.toBeChecked();
  await user.click(screen.getByRole('radio', { name: 'Type my name' }));
  await user.click(screen.getByRole('button', { name: 'Sign contract' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Please tick the acceptance box.');
  expect(sign).not.toHaveBeenCalled();

  await user.click(consent);
  await user.click(screen.getByRole('button', { name: 'Sign contract' }));

  // Result: thank you, when, and that others still sign.
  expect(await screen.findByText('Thank you — you have signed the contract.')).toBeInTheDocument();
  expect(screen.getByText('Signed on at 2026-09-14T10:00:00Z')).toBeInTheDocument();
  expect(screen.getByText(/The contract is complete once everyone has signed/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Download PDF' })).toBeInTheDocument();

  const [sentToken, payload] = sign.mock.calls[0];
  expect(sentToken).toBe(SESSION_TOKEN);
  expect(payload).toEqual({
    name: 'Anna Muster', mode: 'typed', signatureDataUrl: null, accepted: true, idempotencyKey: expect.any(String),
  });
  // The key is kept for the tab, so a retry after a lost response sends the same one.
  expect(window.sessionStorage.getItem(`picpeak.contractSigning.idempotency.${TOKEN}`)).toBe(payload.idempotencyKey);
});

it('runs the single-link flow for a contract sent before signatures v2', async () => {
  invite.mockRejectedValue(httpError(404, { error: 'Signing link not found', code: 'SIGNING_LINK_INVALID' }));
  legacyGet.mockResolvedValue({ contract: { ...baseContract } });
  renderAt(`/contract/${TOKEN}`);

  expect(await screen.findByRole('heading', { name: 'Wedding contract' })).toBeInTheDocument();
  expect(legacyGet).toHaveBeenCalledWith(TOKEN);
  expect(screen.getByText('Draw your signature (optional)')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Sign contract' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Send code' })).toBeNull();
  expect(session).not.toHaveBeenCalled();
});

it('says a link has expired', async () => {
  invite.mockRejectedValue(httpError(410, { code: 'SIGNING_LINK_EXPIRED' }));
  renderAt(`/contract/${TOKEN}`);

  expect(await screen.findByText('This link has expired')).toBeInTheDocument();
  expect(screen.getByText('Ask the sender to send you a new signing link.')).toBeInTheDocument();
  expect(legacyGet).not.toHaveBeenCalled();
});

it('stays verified after a reload, and goes back to the code step once the session ends', async () => {
  window.sessionStorage.setItem(
    `picpeak.contractSigning.session.${TOKEN}`,
    JSON.stringify({ sessionToken: SESSION_TOKEN, expiresAt: '2099-01-01T00:00:00.000Z' }),
  );
  session.mockRejectedValue(httpError(401, { code: 'SIGNING_SESSION_INVALID' }));
  renderAt(`/contract/${TOKEN}`);

  expect(await screen.findByText('Your signing session has ended. Confirm your email again to continue.')).toBeInTheDocument();
  expect(session).toHaveBeenCalledWith(SESSION_TOKEN);
  expect(screen.getByRole('button', { name: 'Send code' })).toBeInTheDocument();
  expect(window.sessionStorage.getItem(`picpeak.contractSigning.session.${TOKEN}`)).toBeNull();
});

it('opens a session from the customer portal without a link or code', async () => {
  window.sessionStorage.setItem(
    'picpeak.contractSigning.session.portal',
    JSON.stringify({ sessionToken: SESSION_TOKEN, expiresAt: '2099-01-01T00:00:00.000Z' }),
  );
  session.mockResolvedValue(sessionView({ verifiedVia: 'portal', waitingForOthers: true, canSign: false }));
  renderAt('/contract/signing');

  expect(await screen.findByRole('heading', { name: 'Wedding contract' })).toBeInTheDocument();
  expect(invite).not.toHaveBeenCalled();
  expect(screen.getByText('It isn\'t your turn yet')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Sign contract' })).toBeNull();
});
