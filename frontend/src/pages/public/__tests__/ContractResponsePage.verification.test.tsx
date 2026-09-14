/**
 * The emailed contract link must not show the contract or the customer's
 * personal data, or accept a signature, until the visitor has confirmed the
 * one-time code; every request after that carries the grant.
 */
import React from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  const interpolate = (s: string, o?: Record<string, unknown>) =>
    s.replace(/\{\{(\w+)\}\}/g, (_m, k) => String(o?.[k] ?? ''));
  return {
    ...actual,
    useTranslation: () => ({
      t: (k: string, fb?: unknown, opts?: Record<string, unknown>) => (typeof fb === 'string' ? interpolate(fb, opts) : k),
      i18n: { language: 'en', changeLanguage: () => Promise.resolve() },
    }),
  };
});
vi.mock('signature_pad', () => ({
  default: class {
    clear() {}
    off() {}
    isEmpty() { return true; }
    toDataURL() { return ''; }
  },
}));
vi.mock('../../../hooks/usePublicDarkMode', () => ({ usePublicDarkMode: () => ({ isDark: false }) }));
vi.mock('../../../config/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../config/api')>();
  return { ...actual, api: { get: vi.fn(), post: vi.fn() } };
});

import { api } from '../../../config/api';
import { ContractResponsePage } from '../ContractResponsePage';

const get = vi.mocked(api.get);
const post = vi.mocked(api.post);
const TOKEN = 'a'.repeat(64);
const STORAGE_KEY = `docAccess:contract:${TOKEN}`;

const shell = {
  verificationRequired: true,
  language: 'en',
  emailHint: 'k***@example.com',
  issuer: { companyName: 'Studio Nord', logoUrl: null, logoUrlDark: null },
};
const fullContract = {
  verificationRequired: false,
  contractNumber: 'C-2026-0007',
  status: 'sent',
  language: 'en',
  issueDate: '2026-09-01',
  validUntil: null,
  title: 'Wedding contract Keller',
  introText: null,
  outroText: null,
  sentAt: null,
  signedByCustomerAt: null,
  signedByAdminAt: null,
  signedCustomerName: null,
  signedAdminName: null,
  hasSignedPdf: false,
  canSign: true,
  sections: [],
  recipient: { displayName: 'Kim Keller', companyName: null, email: 'kim@example.com' },
  issuer: { companyName: 'Studio Nord', addressLine1: null, postalCode: null, city: null, email: null, website: null },
  allowPdfUpload: false,
  requireDrawnSignature: false,
};

const headersOf = (config: unknown) => (config as { headers?: Record<string, string> } | undefined)?.headers;

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/contract/${TOKEN}`]}>
        <Routes>
          <Route path="/contract/:token" element={<ContractResponsePage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function seedGrant(grant = 'grant-abc') {
  window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ grant, expiresAt: Date.now() + 600_000 }));
}

async function signAs(name: string) {
  fireEvent.change(await screen.findByLabelText('Your full name'), { target: { value: name } });
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Sign contract' }));
}

describe('ContractResponsePage verification gate', () => {
  beforeAll(() => {
    HTMLCanvasElement.prototype.getContext = vi.fn(() => null) as never;
  });
  beforeEach(() => {
    get.mockReset();
    post.mockReset();
    window.sessionStorage.clear();
    // The server answers with the full view only when a grant rides along.
    get.mockImplementation(async (_url, config) => ({
      data: { contract: headersOf(config)?.['X-Document-Access'] ? fullContract : shell },
    }));
  });

  it('shows only the verification step for the bare link, then the contract once the code is confirmed', async () => {
    post.mockImplementation(async (url) => {
      if (String(url).endsWith('/verification')) return { data: { sent: true, emailHint: 'k***@example.com', resendAfterSeconds: 30 } };
      if (String(url).endsWith('/verification/confirm')) return { data: { grant: 'grant-abc', expiresInSeconds: 900 } };
      throw new Error(`unexpected POST ${url}`);
    });
    renderPage();

    expect(await screen.findByText("Confirm it's you")).toBeInTheDocument();
    expect(screen.queryByText('kim@example.com')).not.toBeInTheDocument();
    expect(screen.queryByText('Kim Keller')).not.toBeInTheDocument();
    expect(screen.queryByText('Wedding contract Keller')).not.toBeInTheDocument();
    expect(screen.queryByText('C-2026-0007')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign contract' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /send code/i }));
    fireEvent.change(await screen.findByLabelText('6-digit code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: /^confirm$/i }));

    expect(await screen.findByText('Kim Keller')).toBeInTheDocument();
    expect(post).toHaveBeenCalledWith(`/public/contracts/${TOKEN}/verification/confirm`, { code: '123456' });
    expect(headersOf(get.mock.calls.at(-1)?.[1])).toEqual({ 'X-Document-Access': 'grant-abc' });
    expect(JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) || '{}').grant).toBe('grant-abc');
  });

  it('sends the grant with the signature', async () => {
    seedGrant();
    post.mockResolvedValue({ data: { status: 'signed_by_customer', signedAt: '2026-09-14T10:00:00Z' } });
    renderPage();

    await signAs('Kim Keller');

    await waitFor(() => expect(post).toHaveBeenCalledWith(
      `/public/contracts/${TOKEN}/sign`,
      { name: 'Kim Keller', signatureDataUrl: null, accepted: true },
      { headers: { 'X-Document-Access': 'grant-abc' } },
    ));
  });

  it('returns to the verification step and forgets the grant when the server says it is no longer valid', async () => {
    seedGrant();
    post.mockRejectedValue(Object.assign(new Error('Request failed with status code 401'), {
      response: { status: 401, data: { code: 'VERIFICATION_REQUIRED' } },
    }));
    // After the refusal the page asks again without a grant and gets the shell.
    renderPage();

    await signAs('Kim Keller');

    expect(await screen.findByText("For your security, please confirm it's you again.")).toBeInTheDocument();
    expect(screen.queryByText('kim@example.com')).not.toBeInTheDocument();
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});
