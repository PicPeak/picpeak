/**
 * Integrity report card (#1446): an artefact that is gone reads as missing,
 * not as altered; "Hash mismatch" only when both hashes exist and differ.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  const en = (await import('../../../../i18n/locales/en.json')).default as Record<string, unknown>;
  const lookup = (key: string): string | undefined =>
    key.split('.').reduce<unknown>(
      (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
      en,
    ) as string | undefined;
  return {
    ...actual,
    useTranslation: () => ({
      t: (k: string, fb?: unknown) => lookup(k) ?? `MISSING:${k}:${String(fb)}`,
      i18n: { language: 'en' },
    }),
  };
});
vi.mock('react-toastify', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const verifyIntegrity = vi.fn();
vi.mock('../../../../services/contracts.service', async () => {
  const actual = await vi.importActual<typeof import('../../../../services/contracts.service')>(
    '../../../../services/contracts.service',
  );
  return { ...actual, contractsService: { ...actual.contractsService, verifyIntegrity: (...a: unknown[]) => verifyIntegrity(...a) } };
});

import { IntegrityCheckCard } from '../ContractDetailPage';

const leg = { path: null, present: false, expected: null, actual: null, match: false };

test('a gone artefact is "missing", a differing hash is "mismatch"', async () => {
  verifyIntegrity.mockResolvedValue({
    unsigned: leg,
    signed: leg,
    ok: false,
    checks: [
      { check: 'certificate', subject: null, ok: false, expected: null, actual: null, note: 'missing' },
      { check: 'signed_pdf', subject: null, ok: false, expected: 'a'.repeat(64), actual: null, note: 'missing' },
      { check: 'unsigned_pdf', subject: null, ok: false, expected: 'a'.repeat(64), actual: 'b'.repeat(64), note: null },
    ],
  });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter><IntegrityCheckCard contractId={7} /></MemoryRouter>
    </QueryClientProvider>,
  );
  await userEvent.click(screen.getByRole('button', { name: 'Verify' }));
  expect(await screen.findAllByText('Missing — the file (or record) is gone')).toHaveLength(2);
  expect(screen.getAllByText('Hash mismatch — file altered')).toHaveLength(1);
  expect(screen.queryByText('missing')).toBeNull();
  expect(document.body.textContent).not.toContain('MISSING:');
});
