/**
 * The emailed quote link must not show the quote or the customer's personal
 * data, or record a response, until the visitor has confirmed the one-time
 * code. The Accept/Decline hint from the email link survives the detour.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
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
vi.mock('../../../hooks/usePublicDarkMode', () => ({ usePublicDarkMode: () => ({ isDark: false }) }));
vi.mock('../../../hooks/useLocalizedDate', () => ({
  useLocalizedDate: () => ({ formatDateTime: (d: unknown) => String(d), formatTime: (d: unknown) => String(d) }),
}));
vi.mock('../../../config/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../config/api')>();
  return { ...actual, api: { get: vi.fn(), post: vi.fn() } };
});

import { api } from '../../../config/api';
import { QuoteResponsePage } from '../QuoteResponsePage';

const get = vi.mocked(api.get);
const post = vi.mocked(api.post);
const TOKEN = 'b'.repeat(64);
const STORAGE_KEY = `docAccess:quote:${TOKEN}`;

const shell = {
  verificationRequired: true,
  language: 'en',
  emailHint: 'k***@example.com',
  issuer: { companyName: 'Studio Nord', logoUrl: null, logoUrlDark: null },
};
const fullQuote = {
  verificationRequired: false,
  quoteNumber: 'Q-2026-0003',
  status: 'sent',
  language: 'en',
  currency: 'CHF',
  issueDate: '2026-09-01',
  validUntil: null,
  eventName: 'Hochzeit Keller',
  eventDate: null,
  eventTimeStart: null,
  eventTimeEnd: null,
  introText: null,
  outroText: null,
  netAmountMinor: 100000,
  vatRate: 0,
  vatAmountMinor: 0,
  shippingAmountMinor: 0,
  totalAmountMinor: 100000,
  respondedAt: null,
  responseLockedAt: null,
  canRespond: true,
  lineItems: [],
  recipient: { displayName: 'Kim Keller', email: 'kim@example.com', companyName: null },
  issuer: { companyName: 'Studio Nord', email: '', website: '', footerLine: '' },
};

const headersOf = (config: unknown) => (config as { headers?: Record<string, string> } | undefined)?.headers;

function renderPage(path = `/quote/${TOKEN}`) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/quote/:token" element={<QuoteResponsePage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('QuoteResponsePage verification gate', () => {
  beforeEach(() => {
    get.mockReset();
    post.mockReset();
    window.sessionStorage.clear();
    get.mockImplementation(async (_url, config) => ({
      data: { quote: headersOf(config)?.['X-Document-Access'] ? fullQuote : shell },
    }));
  });

  it('shows only the verification step for the bare link, and keeps the email link hint after verifying', async () => {
    post.mockImplementation(async (url) => {
      if (String(url).endsWith('/verification')) return { data: { sent: true, emailHint: 'k***@example.com', resendAfterSeconds: 30 } };
      if (String(url).endsWith('/verification/confirm')) return { data: { grant: 'grant-q', expiresInSeconds: 900 } };
      throw new Error(`unexpected POST ${url}`);
    });
    renderPage(`/quote/${TOKEN}?action=accept`);

    expect(await screen.findByText("Confirm it's you")).toBeInTheDocument();
    expect(screen.queryByText('kim@example.com')).not.toBeInTheDocument();
    expect(screen.queryByText(/Q-2026-0003/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Accept quote' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /send code/i }));
    fireEvent.change(await screen.findByLabelText('6-digit code'), { target: { value: '654321' } });
    fireEvent.click(screen.getByRole('button', { name: /^confirm$/i }));

    expect(await screen.findByText('kim@example.com')).toBeInTheDocument();
    expect(screen.getByText(/You followed the "Accept" link/)).toBeInTheDocument();
  });

  it('sends the grant with the response', async () => {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ grant: 'grant-q', expiresAt: Date.now() + 600_000 }));
    post.mockResolvedValue({ data: { status: 'accepted', lockedAt: '2026-09-14T10:15:00Z' } });
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Accept quote' }));

    await waitFor(() => expect(post).toHaveBeenCalledWith(
      `/public/quotes/${TOKEN}/respond`,
      { action: 'accept', tosAccepted: false },
      { headers: { 'X-Document-Access': 'grant-q' } },
    ));
  });

  it('returns to the verification step when the grant is no longer valid', async () => {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ grant: 'grant-q', expiresAt: Date.now() + 600_000 }));
    post.mockRejectedValue(Object.assign(new Error('Request failed with status code 401'), {
      response: { status: 401, data: { code: 'VERIFICATION_REQUIRED' } },
    }));
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Decline' }));

    expect(await screen.findByText("For your security, please confirm it's you again.")).toBeInTheDocument();
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});
