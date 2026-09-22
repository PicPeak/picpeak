/**
 * Admin → customer record → Activity (#1444 slice 6): every document type is
 * labelled from the locale (not rendered as its raw key), and older entries
 * load page by page.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, describe, it, expect } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  const en = (await import('../../../i18n/locales/en.json')).default as Record<string, unknown>;
  const lookup = (key: string): string | undefined =>
    key.split('.').reduce<unknown>(
      (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
      en,
    ) as string | undefined;
  return {
    ...actual,
    useTranslation: () => ({
      t: (k: string, fb?: unknown, opts?: Record<string, unknown>) => {
        const vars = (typeof fb === 'object' && fb ? fb : opts) as Record<string, unknown> | undefined;
        const found = lookup(k);
        const base = typeof found === 'string' ? found
          : (typeof fb === 'string' ? fb : String((vars as { defaultValue?: string })?.defaultValue ?? k));
        return vars ? base.replace(/\{\{(\w+)\}\}/g, (_m, key) => String(vars[key] ?? '')) : base;
      },
      i18n: { language: 'en' },
    }),
  };
});
vi.mock('../../../hooks/useLocalizedDate', () => ({
  useLocalizedDate: () => ({ format: (d: string) => d, formatDateTime: (d: string) => d }),
}));

const activity = vi.hoisted(() => vi.fn());
vi.mock('../../../services/customerAdmin.service', () => ({ customerAdminService: { activity } }));

import { CustomerActivityCard } from '../CustomerActivityCard';

const entry = (id: number, type: string, over = {}) => ({
  id, type, at: '2026-09-20T10:00:00.000Z', actorType: 'admin', actorName: 'tester', eventId: null, metadata: {}, ...over,
});

describe('CustomerActivityCard', () => {
  it('labels document and account activity, and loads older entries', async () => {
    activity
      .mockResolvedValueOnce({
        entries: [
          entry(9, 'customer_document_shared', { metadata: { documentId: 4 } }),
          entry(8, 'customer_document_uploaded', { actorType: 'customer', actorName: null, metadata: { documentId: 4 } }),
          entry(7, 'customer_login', { actorType: 'customer', actorName: null }),
        ],
        nextBeforeId: 7,
      })
      .mockResolvedValueOnce({ entries: [entry(3, 'customer_document_scan_rejected')], nextBeforeId: null });

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><CustomerActivityCard customerId={5} /></QueryClientProvider>);

    expect(await screen.findByText('Document shared with a customer (#4)')).toBeInTheDocument();
    expect(screen.getByText('Customer document uploaded (#4)')).toBeInTheDocument();
    // The shared label names the customer; on their own record the tail goes.
    expect(screen.getByText('Customer logged in')).toBeInTheDocument();
    expect(screen.getByText('By tester')).toBeInTheDocument();
    expect(screen.getAllByText('By the customer')).toHaveLength(2);

    await userEvent.click(screen.getByRole('button', { name: 'Show older' }));
    expect(await screen.findByText('A customer document failed the security check')).toBeInTheDocument();
    await waitFor(() => expect(activity).toHaveBeenLastCalledWith(5, 7));
    expect(screen.queryByRole('button', { name: 'Show older' })).toBeNull();
  });
});
