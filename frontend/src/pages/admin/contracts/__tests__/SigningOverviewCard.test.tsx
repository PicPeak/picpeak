/**
 * Signing overview (#1446): a signer who has their link can be sent a
 * reminder, through the same path as the reminder ladder.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

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
vi.mock('react-toastify', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../../../../components/admin/PermissionGate', () => ({
  PermissionGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../../../../hooks/useLocalizedDate', () => ({
  useLocalizedDate: () => ({ format: String, formatDateTime: String, formatTime: String }),
}));

const remindSigner = vi.fn();
vi.mock('../../../../services/contracts.service', async () => {
  const actual = await vi.importActual<typeof import('../../../../services/contracts.service')>(
    '../../../../services/contracts.service',
  );
  return { ...actual, contractsService: { ...actual.contractsService, remindSigner: (...a: unknown[]) => remindSigner(...a) } };
});

import { SigningOverviewCard } from '../SigningOverviewCard';

const signer = {
  id: 21, position: 1, role: 'customer', slotKey: 'customer-1', name: 'Anna Muster', email: 'anna@example.com',
  status: 'invited', invitedAt: '2026-09-10T10:00:00Z', verifiedAt: null, verifiedVia: null, signedAt: null,
  declinedAt: null, signatureMode: null, reminderCount: 1, remindedAt: '2026-09-13T10:00:00Z',
};

test('sends a reminder to a signer who has a link, and says how often they were reminded', async () => {
  remindSigner.mockResolvedValue({ reminded: true, step: 2 });
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <SigningOverviewCard
        contractId={7}
        contractStatus="sent"
        overview={{ version: 2, order: 'parallel', followUp: null, signers: [signer], events: [], chain: null } as never}
      />
    </QueryClientProvider>,
  );
  expect(screen.getByText(/Reminded 1×, last 2026-09-13T10:00:00Z/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Send reminder' }));
  await waitFor(() => expect(remindSigner).toHaveBeenCalledWith(7, 21));
  expect(document.body.textContent).not.toContain('MISSING:');
});

test('offers a new link to the first signer while their details are collected', () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <SigningOverviewCard
        contractId={7}
        contractStatus="awaiting_data"
        overview={{ version: 2, order: 'parallel', followUp: null, signers: [signer], events: [], chain: null } as never}
      />
    </QueryClientProvider>,
  );
  expect(screen.getByRole('button', { name: 'Send the link again' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Send reminder' })).toBeInTheDocument();
});

describe('a failed follow-up step', () => {
  const renderWith = (followUp: Record<string, unknown>) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <SigningOverviewCard
          contractId={7}
          contractStatus="sent"
          overview={{ version: 2, order: 'parallel', followUp, signers: [signer], events: [], chain: null } as never}
        />
      </QueryClientProvider>,
    );
    return screen.getByRole('alert');
  };

  test('an invitation failure says the email is retried, not that a signature exists', () => {
    const alert = renderWith({ failedAt: '2026-09-22T10:00:00Z', step: 'invitation', code: null });
    expect(alert).toHaveTextContent("The invitation email couldn't be queued");
    expect(alert).toHaveTextContent('It is retried automatically within the hour.');
    expect(alert).not.toHaveTextContent(/signature/i);
    expect(document.body.textContent).not.toContain('MISSING:');
  });

  test('an unreadable address says what to check', () => {
    const alert = renderWith({ failedAt: '2026-09-22T10:00:00Z', step: 'next_invitation', code: 'SIGNER_EMAIL_UNREADABLE' });
    expect(alert).toHaveTextContent("the signer's email address can't be read. Check the evidence key");
  });

  test('a step after the signature names the step in words', () => {
    const alert = renderWith({ failedAt: '2026-09-22T10:00:00Z', step: 'completion', code: null });
    expect(alert).toHaveTextContent("A step after the signature didn't go through");
    expect(alert).toHaveTextContent('the signing certificate or the completion emails');
    expect(document.body.textContent).not.toContain('MISSING:');
  });

  test.each([
    ['reminder', "A reminder email couldn't be queued"],
    ['data_freeze', "The contract couldn't be prepared with the customer's details"],
    ['prepare_contract_invoice', "The invoice for this contract couldn't be prepared"],
    ['something_new', "A step didn't go through"],
  ])('the %s step has its own message', (step, text) => {
    expect(renderWith({ failedAt: '2026-09-22T10:00:00Z', step, code: null })).toHaveTextContent(text);
    expect(document.body.textContent).not.toContain('MISSING:');
  });
});
