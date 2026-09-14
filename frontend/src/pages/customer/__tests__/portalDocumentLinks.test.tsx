/**
 * The customer portal used to hand out the emailed signing/response tokens as
 * `/contract/<token>` and `/quote/<token>` links. It now links to its own
 * routes, which sign and respond through the portal session: no token URL may
 * appear, and portal actions must never go through the public link services.
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
vi.mock('../../../hooks/useLocalizedDate', () => ({
  useLocalizedDate: () => ({ formatDateTime: (d: unknown) => String(d), formatTime: (d: unknown) => String(d) }),
}));

// vi.mock factories are hoisted above the imports, so the spies they close
// over must be created in vi.hoisted.
const { customer, publicSign, publicRespond } = vi.hoisted(() => ({
  customer: {
    listContracts: vi.fn(),
    listQuotes: vi.fn(),
    getContract: vi.fn(),
    signContract: vi.fn(),
    uploadSignedContractPdf: vi.fn(),
    contractPdfUrl: vi.fn(),
    getQuote: vi.fn(),
    respondToQuote: vi.fn(),
    quotePdfUrl: vi.fn(),
  },
  publicSign: vi.fn(),
  publicRespond: vi.fn(),
}));
vi.mock('../../../services/customer.service', () => ({ customerService: customer }));

vi.mock('../../../services/contracts.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../services/contracts.service')>();
  return { ...actual, publicContractsService: { ...actual.publicContractsService, sign: publicSign } };
});
vi.mock('../../../services/quotes.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../services/quotes.service')>();
  return { ...actual, publicQuotesService: { ...actual.publicQuotesService, respond: publicRespond } };
});

import { CustomerContractsPage } from '../CustomerContractsPage';
import { CustomerQuotesPage } from '../CustomerQuotesPage';
import { CustomerContractSignPage } from '../CustomerContractSignPage';
import { CustomerQuoteRespondPage } from '../CustomerQuoteRespondPage';

function renderAt(path: string, routePath: string, element: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path={routePath} element={element} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return view;
}

const tokenLinks = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('a')).map((a) => a.getAttribute('href') || '')
    .filter((href) => /^\/(contract|quote)\//.test(href));

const contractRow = (overrides: Record<string, unknown>) => ({
  id: 5, contractNumber: 'C-2026-0005', status: 'sent', language: 'en', issueDate: '2026-09-01',
  validUntil: null, title: 'Wedding', sentAt: null, signedByCustomerAt: null, signedByAdminAt: null,
  signedCustomerName: null, signedAdminName: null, hasPdf: true, hasSignedPdf: false, canSign: true,
  ...overrides,
});
const quoteRow = (overrides: Record<string, unknown>) => ({
  id: 9, quoteNumber: 'Q-2026-0009', status: 'sent', currency: 'CHF', issueDate: '2026-09-01',
  validUntil: null, eventName: 'Hochzeit', eventDate: null, netAmountMinor: 100000, vatRate: 0,
  vatAmountMinor: 0, shippingAmountMinor: 0, totalAmountMinor: 100000, introText: null, outroText: null,
  sentAt: null, respondedAt: null, responseLockedAt: null, acceptedAt: null, declinedAt: null, canRespond: true,
  ...overrides,
});

const fullContract = {
  contractNumber: 'C-2026-0005', status: 'sent', language: 'en', issueDate: '2026-09-01', validUntil: null,
  title: 'Wedding', introText: null, outroText: null, sentAt: null, signedByCustomerAt: null,
  signedByAdminAt: null, signedCustomerName: null, signedAdminName: null, hasSignedPdf: false, canSign: true,
  sections: [], recipient: { displayName: 'Kim Keller', companyName: null, email: 'kim@example.com' },
  issuer: { companyName: 'Studio Nord', addressLine1: null, postalCode: null, city: null, email: null, website: null },
  allowPdfUpload: false, requireDrawnSignature: false,
};
const fullQuote = {
  quoteNumber: 'Q-2026-0009', status: 'sent', language: 'en', currency: 'CHF', issueDate: '2026-09-01',
  validUntil: null, eventName: null, eventDate: null, eventTimeStart: null, eventTimeEnd: null,
  introText: null, outroText: null, netAmountMinor: 100000, vatRate: 0, vatAmountMinor: 0,
  shippingAmountMinor: 0, totalAmountMinor: 100000, respondedAt: null, responseLockedAt: null,
  canRespond: true, lineItems: [], recipient: { displayName: 'Kim Keller', email: 'kim@example.com', companyName: null },
  issuer: { companyName: 'Studio Nord', email: '', website: '', footerLine: '' },
};

describe('customer portal contract and quote links', () => {
  beforeAll(() => {
    HTMLCanvasElement.prototype.getContext = vi.fn(() => null) as never;
  });
  beforeEach(() => {
    Object.values(customer).forEach((fn) => fn.mockReset());
    publicSign.mockReset();
    publicRespond.mockReset();
  });

  it('links a signable contract to the portal signing page and never to a token URL', async () => {
    customer.listContracts.mockResolvedValue([
      contractRow({}),
      contractRow({ id: 6, contractNumber: 'C-2026-0006', status: 'fully_signed', canSign: false, hasSignedPdf: true }),
    ]);
    const { container } = renderAt('/customer/contracts', '/customer/contracts', <CustomerContractsPage />);

    const link = await screen.findByRole('link', { name: /open & sign/i });
    expect(link).toHaveAttribute('href', '/customer/contracts/5/sign');
    expect(screen.getAllByRole('link', { name: /open & sign/i })).toHaveLength(1);
    expect(tokenLinks(container)).toEqual([]);
  });

  it('links an open quote to the portal response page and never to a token URL', async () => {
    customer.listQuotes.mockResolvedValue([
      quoteRow({}),
      quoteRow({ id: 10, quoteNumber: 'Q-2026-0010', status: 'accepted', canRespond: false }),
    ]);
    const { container } = renderAt('/customer/quotes', '/customer/quotes', <CustomerQuotesPage />);

    await screen.findByText('Q-2026-0009');
    const hrefs = Array.from(container.querySelectorAll('a')).map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('/customer/quotes/9/respond');
    expect(hrefs).not.toContain('/customer/quotes/10/respond');
    expect(tokenLinks(container)).toEqual([]);
  });

  it('signs through the portal session, without a verification step or the public link service', async () => {
    customer.getContract.mockResolvedValue({ contract: fullContract, canSign: true });
    customer.signContract.mockResolvedValue({ status: 'signed_by_customer', signedAt: '2026-09-14T10:00:00Z' });
    renderAt('/customer/contracts/5/sign', '/customer/contracts/:id/sign', <CustomerContractSignPage />);

    fireEvent.change(await screen.findByLabelText('Your full name'), { target: { value: 'Kim Keller' } });
    expect(screen.queryByText("Confirm it's you")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Sign contract' }));

    await waitFor(() => expect(customer.signContract).toHaveBeenCalledWith(5, {
      name: 'Kim Keller', signatureDataUrl: null, accepted: true,
    }));
    expect(publicSign).not.toHaveBeenCalled();
  });

  it('responds to a quote through the portal session, not the public link service', async () => {
    customer.getQuote.mockResolvedValue({ quote: fullQuote, canRespond: true });
    customer.respondToQuote.mockResolvedValue({ status: 'accepted', lockedAt: '2026-09-14T10:15:00Z' });
    renderAt('/customer/quotes/9/respond', '/customer/quotes/:id/respond', <CustomerQuoteRespondPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Accept quote' }));

    await waitFor(() => expect(customer.respondToQuote).toHaveBeenCalledWith(9, 'accept', { tosAccepted: false }));
    expect(publicRespond).not.toHaveBeenCalled();
  });
});
