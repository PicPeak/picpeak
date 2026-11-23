/**
 * Quote detail → "Stored versions": every PDF the quote went out as, newest
 * first, with the total and lines stored with it; each opens its own file.
 * Hidden until the quote has been sent once.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { formatMoneyMinor } from '../../../../utils/money';

// Resolve against the real en.json so a missing key shows up as a failure.
vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  const en = (await import('../../../../i18n/locales/en.json')).default as Record<string, unknown>;
  const lookup = (key: string): string | undefined =>
    key.split('.').reduce<unknown>(
      (node, part) => (node && typeof node === 'object'
        ? (node as Record<string, unknown>)[part] : undefined),
      en,
    ) as string | undefined;
  return {
    ...actual,
    useTranslation: () => ({
      t: (k: string, fb?: unknown) => lookup(k) ?? (typeof fb === 'string' ? fb : k),
      i18n: { language: 'en' },
    }),
  };
});
const toastError = vi.fn();
vi.mock('react-toastify', () => ({ toast: { error: (...args: unknown[]) => toastError(...args) } }));
vi.mock('../../../../hooks/useLocalizedDate', () => ({
  useLocalizedDate: () => ({ formatDateTime: (d: string) => `at ${d}` }),
}));

const documents = vi.fn();
const documentPdfUrl = vi.fn();
vi.mock('../../../../services/quotes.service', () => ({
  quotesService: {
    documents: (...args: unknown[]) => documents(...args),
    documentPdfUrl: (...args: unknown[]) => documentPdfUrl(...args),
  },
}));

import { QuoteVersionsCard } from '../QuoteVersionsCard';

const summary = (images: number, totalMinor: number) => ({
  currency: 'CHF', netAmountMinor: totalMinor, totalAmountMinor: totalMinor,
  lines: [{ description: 'Edited images', quantity: images, unit: null, lineTotalMinor: totalMinor, lineKind: 'item', notIncluded: false }],
});

function renderCard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}><QuoteVersionsCard quoteId={7} currency="CHF" /></QueryClientProvider>,
  );
}

test('lists each send with what it offered and opens its own file', async () => {
  documents.mockResolvedValue({
    documents: [
      { id: 21, kind: 'sent', generatedAt: '2026-11-20', pages: 1, bytes: 1, summary: summary(40, 30000) },
      { id: 20, kind: 'sent', generatedAt: '2026-11-10', pages: 1, bytes: 1, summary: summary(80, 40000) },
      { id: 5, kind: 'sent', generatedAt: '2026-01-01', pages: 1, bytes: 1, summary: null },
    ],
  });
  documentPdfUrl.mockResolvedValue('blob:x');
  const win = { location: { href: '' }, close: vi.fn() };
  vi.spyOn(window, 'open').mockReturnValue(win as unknown as Window);

  renderCard();
  expect(await screen.findByText('Stored versions')).toBeInTheDocument();
  expect(screen.getByText('at 2026-11-10')).toBeInTheDocument();
  expect(document.body.textContent).toContain(formatMoneyMinor(40000, 'CHF'));
  expect(screen.getByText(/^80 · Edited images$/)).toBeInTheDocument();
  expect(screen.getByText(/^40 · Edited images$/)).toBeInTheDocument();
  // A file stored before summaries were kept still opens.
  expect(screen.getByText('at 2026-01-01')).toBeInTheDocument();

  const buttons = screen.getAllByRole('button', { name: /Open PDF/ });
  expect(buttons).toHaveLength(3);
  await userEvent.click(buttons[1]);
  expect(documentPdfUrl).toHaveBeenCalledWith(7, 20);
  expect(win.location.href).toBe('blob:x');
});

test('a quote never sent shows nothing', async () => {
  documents.mockResolvedValue({ documents: [] });
  const { container } = renderCard();
  await vi.waitFor(() => expect(documents).toHaveBeenCalled());
  expect(container).toBeEmptyDOMElement();
});

test('a missing file says so, though the error body arrives as a Blob', async () => {
  documents.mockResolvedValue({
    documents: [{ id: 30, kind: 'sent', generatedAt: '2026-11-20', pages: 1, bytes: 1, summary: null }],
  });
  const body = new Blob([JSON.stringify({ error: 'The stored PDF file is missing', code: 'DOCUMENT_FILE_MISSING' })], { type: 'application/json' });
  documentPdfUrl.mockRejectedValue(Object.assign(new Error('Request failed with status code 404'), { response: { status: 404, data: body } }));
  const win = { location: { href: '' }, close: vi.fn() };
  vi.spyOn(window, 'open').mockReturnValue(win as unknown as Window);

  renderCard();
  await userEvent.click(await screen.findByRole('button', { name: /Open PDF/ }));
  await vi.waitFor(() => expect(toastError).toHaveBeenCalledWith('This PDF is no longer on the server.'));
  expect(win.close).toHaveBeenCalled();
});

test('an offered add-on is labelled', async () => {
  documents.mockResolvedValue({
    documents: [{
      id: 31, kind: 'sent', generatedAt: '2026-11-20', pages: 1, bytes: 1,
      summary: { ...summary(10, 10000), lines: [{ description: 'Album', quantity: 1, unit: null, lineTotalMinor: 30000, lineKind: 'item', isOptional: true, notIncluded: false }] },
    }],
  });
  renderCard();
  expect(await screen.findByText('(add-on)')).toBeInTheDocument();
  expect(screen.getByText(/^1 · Album$/)).toBeInTheDocument();
});

test('a row without an amount shows its text only', async () => {
  documents.mockResolvedValue({
    documents: [{
      id: 32, kind: 'sent', generatedAt: '2026-11-20', pages: 1, bytes: 1,
      summary: { ...summary(10, 10000), lines: [
        { description: 'Wedding day', quantity: 1, unit: null, lineTotalMinor: 0, lineKind: 'item', notIncluded: false },
        { description: 'Edited images', quantity: 10, unit: null, lineTotalMinor: 10000, lineKind: 'item', notIncluded: false },
      ] },
    }],
  });
  renderCard();
  expect(await screen.findByText(/^Wedding day$/)).toBeInTheDocument();
  expect(screen.getByText(/^10 · Edited images$/)).toBeInTheDocument();
  expect(document.body.textContent).not.toContain(formatMoneyMinor(0, 'CHF'));
});
