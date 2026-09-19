/**
 * Customer portal → Documents (#1444).
 *
 * The page is where a customer learns whether a file they sent has been
 * accepted, so status must be readable as text (not only colour), a file that
 * isn't available must not offer a download, and an upload failure has to
 * name the file and say what to do.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

import type { CustomerDocument } from '../../../services/customer.service';

// Resolve against the REAL en.json so a missing `customer.documents.*` key
// shows up as a failing label rather than a fallback that looks right.
vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  const en = (await import('../../../i18n/locales/en.json')).default as Record<string, unknown>;
  const lookup = (key: string): string | undefined =>
    key.split('.').reduce<unknown>(
      (node, part) => (node && typeof node === 'object'
        ? (node as Record<string, unknown>)[part] : undefined),
      en
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
      i18n: { language: 'en' },
    }),
  };
});

vi.mock('react-toastify', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock('../../../hooks/useLocalizedDate', () => ({
  useLocalizedDate: () => ({
    format: (d: string) => String(d).slice(0, 10),
    formatDateTime: (d: string) => String(d),
  }),
}));

const makeDoc = (over: Partial<CustomerDocument>): CustomerDocument => ({
  id: 1, name: 'contract.pdf', sizeBytes: 2048, uploadedBy: 'you', status: 'pending',
  downloadable: false, rejectionReason: null, eventId: null, eventName: null,
  contractId: null, createdAt: '2026-09-01T10:00:00Z', sharedAt: null,
  ...over,
});

let docs: CustomerDocument[] = [];
const downloadSpy = vi.fn(async () => undefined);
const uploadSpy = vi.fn(async (): Promise<CustomerDocument> => makeDoc({ id: 99 }));

vi.mock('../../../services/customer.service', () => ({
  customerService: {
    listDocuments: vi.fn(async () => ({
      documents: docs,
      limits: { maxUploadBytes: 25 * 1024 * 1024, quotaBytes: 250 * 1024 * 1024, usedBytes: 4096 },
    })),
    listEvents: vi.fn(async () => []),
    uploadDocument: (...a: unknown[]) => uploadSpy(...(a as [])),
    downloadDocument: (...a: unknown[]) => downloadSpy(...(a as [])),
  },
}));

import { CustomerDocumentsPage } from '../CustomerDocumentsPage';

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter><CustomerDocumentsPage /></MemoryRouter>
    </QueryClientProvider>
  );
}

describe('CustomerDocumentsPage', () => {
  beforeEach(() => {
    downloadSpy.mockClear();
    uploadSpy.mockClear();
    docs = [
      makeDoc({ id: 1, name: 'signed-contract.pdf', status: 'pending' }),
      makeDoc({ id: 2, name: 'offer.pdf', status: 'clean', downloadable: true, uploadedBy: 'studio' }),
      makeDoc({ id: 3, name: 'old-version.pdf', status: 'rejected', rejectionReason: 'Wrong version' }),
    ];
  });

  it('labels every status in words and offers download only for available files', async () => {
    renderPage();
    expect(await screen.findByText('signed-contract.pdf')).toBeInTheDocument();
    expect(screen.getByText('Awaiting review')).toBeInTheDocument();
    expect(screen.getByText('Available')).toBeInTheDocument();
    expect(screen.getByText('Rejected')).toBeInTheDocument();
    expect(screen.getByText('Not accepted: Wrong version')).toBeInTheDocument();

    const downloads = screen.getAllByRole('button', { name: /^Download / });
    expect(downloads).toHaveLength(1);
    expect(downloads[0]).toHaveAccessibleName('Download offer.pdf');
  });

  it('downloads through the service', async () => {
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Download offer.pdf' }));
    expect(downloadSpy).toHaveBeenCalledWith(expect.objectContaining({ id: 2, name: 'offer.pdf' }));
  });

  it('refuses a file that is not a PDF before sending it', async () => {
    renderPage();
    const input = await screen.findByLabelText('PDF file');
    fireEvent.change(input, { target: { files: [new File(['x'], 'holiday.jpg', { type: 'image/jpeg' })] } });
    expect(await screen.findByText('holiday.jpg is not a PDF. Only PDF documents can be uploaded.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Upload/ })).toBeDisabled();
    expect(uploadSpy).not.toHaveBeenCalled();
  });

  it('names the file in a server rejection and offers a retry', async () => {
    uploadSpy.mockRejectedValueOnce({ response: { status: 400, data: { code: 'PDF_ENCRYPTED' } } });
    renderPage();
    const input = await screen.findByLabelText('PDF file');
    await userEvent.upload(input, new File(['%PDF-1.4'], 'locked.pdf', { type: 'application/pdf' }));
    await userEvent.click(screen.getByRole('button', { name: /Upload/ }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(
      'locked.pdf is password-protected. Remove the password and upload it again.',
    ));
    expect(screen.getByRole('button', { name: /Try again/ })).toBeEnabled();
  });

  it('names the new refusals the deeper PDF check produces (#1444)', async () => {
    // The check behind the upload got stricter (plan slice 1d). Each refusal
    // has to say what the customer can do about it, not fall back to
    // "could not be uploaded".
    for (const [code, expected] of [
      ['PDF_ACTIVE_CONTENT', /contains active content[\s\S]*print it to PDF/],
      ['PDF_TOO_COMPLEX', /could not be checked[\s\S]*print it to PDF/],
      ['PDF_TOO_MANY_PAGES', /has too many pages/],
    ] as const) {
      uploadSpy.mockRejectedValueOnce({ response: { status: 400, data: { code } } });
      const view = renderPage();
      const input = await screen.findByLabelText('PDF file');
      await userEvent.upload(input, new File(['%PDF-1.4'], 'scan.pdf', { type: 'application/pdf' }));
      await userEvent.click(screen.getByRole('button', { name: /Upload/ }));
      await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(expected));
      expect(screen.getByRole('status')).toHaveTextContent('scan.pdf');
      view.unmount();
    }
  });

  it('styles every status chip through the theme-aware class, never a fixed light colour', async () => {
    // The chips are the page's only colour-carrying elements, and the portal
    // themes through CSS tokens rather than the `dark` class the admin shell
    // toggles on <html> — so a Tailwind `bg-green-100` (or even a `dark:`
    // variant) renders its light value on the portal's dark ground. The
    // token-derived `.status-chip` classes are what read on both.
    renderPage();
    await screen.findByText('signed-contract.pdf');
    for (const label of ['Awaiting review', 'Available', 'Rejected']) {
      const chip = screen.getByText(label).className;
      expect(chip).toMatch(/\bstatus-chip\b/);
      expect(chip).not.toMatch(/\bbg-(green|amber|red)-\d{2,3}\b/);
    }
  });

  it('confirms a received upload as awaiting review', async () => {
    renderPage();
    const input = await screen.findByLabelText('PDF file');
    await userEvent.upload(input, new File(['%PDF-1.4'], 'scan.pdf', { type: 'application/pdf' }));
    await userEvent.click(screen.getByRole('button', { name: /Upload/ }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(
      'scan.pdf was received. It becomes available once your photographer has reviewed it.',
    ));
    expect(uploadSpy).toHaveBeenCalledTimes(1);
  });
});
