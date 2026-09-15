/**
 * Contract editor → Signers card (#1446): add and remove customer signers,
 * pick the order, and save them with their own button.
 */
import { render, screen, waitFor } from '@testing-library/react';
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
        const base = lookup(k) ?? (typeof fb === 'string' ? fb : k);
        const vars = (typeof fb === 'object' && fb ? fb : opts) as Record<string, unknown> | undefined;
        if (!vars) return base;
        return base.replace(/\{\{(\w+)\}\}/g, (_m, key) => String(vars[key] ?? ''));
      },
      i18n: { language: 'en' },
    }),
  };
});

const toastSuccess = vi.fn();
vi.mock('react-toastify', () => ({ toast: { success: (...args: unknown[]) => toastSuccess(...args), error: vi.fn() } }));
vi.mock('../../../../components/admin/PermissionGate', () => ({
  PermissionGate: ({ children }: { children: React.ReactNode }) => children,
}));

const signers = vi.fn();
const setSigners = vi.fn();
vi.mock('../../../../services/contracts.service', async () => {
  const actual = await vi.importActual<typeof import('../../../../services/contracts.service')>(
    '../../../../services/contracts.service',
  );
  return {
    ...actual,
    contractsService: {
      ...actual.contractsService,
      signers: (...args: unknown[]) => signers(...args),
      setSigners: (...args: unknown[]) => setSigners(...args),
    },
  };
});

import { SignersEditorCard } from '../SignersEditorCard';

const signerRow = (id: number, position: number, role: 'customer' | 'issuer', name: string, email: string | null) => ({
  id, position, role, slotKey: role === 'issuer' ? 'issuer' : `customer-${position}`, name, email,
  status: 'pending', invitedAt: null, verifiedAt: null, verifiedVia: null, signedAt: null, declinedAt: null, signatureMode: null,
});

const overview = (rows: ReturnType<typeof signerRow>[], order = 'parallel') => ({
  version: null, order, signers: rows, events: [], chain: null,
});

function renderCard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SignersEditorCard contractId={4} customerName="Anna Muster" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  setSigners.mockImplementation(async (_id: number, payload: { order: string; signers: Array<{ name: string; email: string }> }) => overview([
    ...payload.signers.map((s, i) => signerRow(20 + i, i + 1, 'customer', s.name, s.email)),
    signerRow(9, payload.signers.length + 1, 'issuer', 'Studio Licht', null),
  ], payload.order));
});

it('explains the default, adds and removes signers, and saves them with the order', async () => {
  const user = userEvent.setup();
  signers.mockResolvedValue(overview([]));
  renderCard();

  expect(await screen.findByText('No signers added yet — the contract\'s customer (Anna Muster) signs by default.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /save signers/i })).toBeDisabled();

  const add = screen.getByRole('button', { name: /add signer/i });
  await user.click(add);
  await user.click(add);
  await user.click(add);
  await user.type(screen.getByLabelText('Name of signer 1'), 'Anna Muster');
  await user.type(screen.getByLabelText('Email of signer 1'), 'anna@example.com');
  await user.type(screen.getByLabelText('Name of signer 2'), 'Not needed');
  await user.type(screen.getByLabelText('Name of signer 3'), 'Ben Muster');
  await user.type(screen.getByLabelText('Email of signer 3'), 'ben@example.com');
  await user.click(screen.getByRole('button', { name: 'Remove signer 2' }));
  expect(screen.queryByDisplayValue('Not needed')).toBeNull();

  // The issuer is listed last, read-only.
  expect(screen.getByText('Signs last, from this page')).toBeInTheDocument();

  await user.click(screen.getByRole('radio', { name: /one after the other/i }));
  await user.click(screen.getByRole('button', { name: /save signers/i }));

  await waitFor(() => expect(setSigners).toHaveBeenCalledWith(4, {
    order: 'sequential',
    signers: [
      { name: 'Anna Muster', email: 'anna@example.com' },
      { name: 'Ben Muster', email: 'ben@example.com' },
    ],
  }));
  expect(toastSuccess).toHaveBeenCalledWith('Signers saved.');
  // Saved: the issuer row now carries the company name from the server.
  expect(await screen.findByText('Studio Licht')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /save signers/i })).toBeDisabled();
});

it('loads the saved signers and does not save an invalid email', async () => {
  const user = userEvent.setup();
  signers.mockResolvedValue(overview([
    signerRow(11, 1, 'customer', 'Anna Muster', 'anna@example.com'),
    signerRow(12, 2, 'issuer', 'Studio Licht', null),
  ], 'sequential'));
  renderCard();

  expect(await screen.findByDisplayValue('anna@example.com')).toBeInTheDocument();
  expect(screen.getByRole('radio', { name: /one after the other/i })).toBeChecked();

  await user.click(screen.getByRole('button', { name: /add signer/i }));
  await user.type(screen.getByLabelText('Name of signer 2'), 'Ben Muster');
  await user.type(screen.getByLabelText('Email of signer 2'), 'ben-at-example');
  await user.click(screen.getByRole('button', { name: /save signers/i }));

  expect(await screen.findByRole('alert')).toHaveTextContent('Signer 2: enter a valid email address.');
  expect(setSigners).not.toHaveBeenCalled();
});

it('stops at five signers', async () => {
  const user = userEvent.setup();
  signers.mockResolvedValue(overview([]));
  renderCard();

  const add = await screen.findByRole('button', { name: /add signer/i });
  for (let i = 0; i < 5; i += 1) await user.click(add);

  expect(screen.getByLabelText('Name of signer 5')).toBeInTheDocument();
  expect(add).toBeDisabled();
  expect(screen.getByText('You can add up to 5 signers.')).toBeInTheDocument();
});
