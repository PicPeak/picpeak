/**
 * Admin paper-copy upload (#1446): once any signer has signed in the browser
 * the server refuses the upload, so the dialog says why and offers no upload.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

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
      t: (k: string, fb?: unknown, opts?: Record<string, unknown>) => {
        const found = lookup(k);
        if (found === undefined) return `MISSING:${k}`;
        const vars = (typeof fb === 'object' && fb ? fb : opts) as Record<string, unknown> | undefined;
        if (!vars) return found;
        return found.replace(/\{\{(\w+)\}\}/g, (_m, key) => String(vars[key] ?? ''));
      },
      i18n: { language: 'en' },
    }),
  };
});

const coverage = vi.fn();
vi.mock('../../../../services/contracts.service', async () => {
  const actual = await vi.importActual<typeof import('../../../../services/contracts.service')>(
    '../../../../services/contracts.service',
  );
  return {
    ...actual,
    contractsService: {
      ...actual.contractsService,
      paperSignatureCoverage: (...args: unknown[]) => coverage(...args),
    },
  };
});

import { PaperSignatureUploadDialog } from '../PaperSignatureUploadDialog';

function renderDialog(onUpload = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <PaperSignatureUploadDialog contractId={7} isOpen onClose={vi.fn()} onUpload={onUpload} />
    </QueryClientProvider>,
  );
  return onUpload;
}

const pdf = () => new File(['%PDF-1.4'], 'paper.pdf', { type: 'application/pdf' });

beforeEach(() => coverage.mockReset());

test('with nobody signed yet, every signer is confirmed before the upload', async () => {
  coverage.mockResolvedValue({
    signers: [{ id: 11, position: 1, name: 'Anna Muster', status: 'invited' }],
    electronicSignaturePresent: false,
  });
  const onUpload = renderDialog();
  const box = await screen.findByRole('checkbox', { name: 'Anna Muster' });
  await userEvent.upload(screen.getByLabelText('The signed PDF'), pdf());
  const submit = screen.getByRole('button', { name: /Upload signed PDF/ });
  expect(submit).toBeDisabled();
  await userEvent.click(box);
  expect(submit).toBeEnabled();
  await userEvent.click(submit);
  expect(onUpload).toHaveBeenCalledWith(expect.any(File), [11]);
  expect(document.body.textContent).not.toContain('MISSING:');
});

test('once a signer has signed in the browser, the upload is not offered and the dialog says why', async () => {
  coverage.mockResolvedValue({
    signers: [{ id: 12, position: 2, name: 'Ben Muster', status: 'invited' }],
    electronicSignaturePresent: true,
  });
  renderDialog();
  expect(await screen.findByText('Already signed in the browser')).toBeInTheDocument();
  expect(screen.getByText(/can't replace a signature given in the browser/)).toBeInTheDocument();
  expect(screen.queryByRole('checkbox')).toBeNull();
  expect(screen.queryByLabelText('The signed PDF')).toBeNull();
  expect(screen.queryByRole('button', { name: /Upload signed PDF/ })).toBeNull();
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  expect(document.body.textContent).not.toContain('MISSING:');
});
