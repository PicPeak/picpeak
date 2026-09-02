/**
 * Turning Invoices (`bills`) on force-enables the Accounting master, but
 * turning it back off used to leave Accounting silently on and freshly
 * unlocked — an orphaned parent area after a trial toggle (QA S9).
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const serverFlags: Record<string, boolean> = {};
vi.mock('../../services/featureFlags.service', () => ({
  featureFlagsService: {
    get: vi.fn(async () => ({ ...serverFlags })),
    update: vi.fn(async (f: Record<string, boolean>) => f),
  },
}));

import { FeatureFlagsProvider, useFeatureFlags, DEFAULT_FLAGS } from '../FeatureFlagsContext';

function renderFlags(overrides: Record<string, boolean>) {
  Object.assign(serverFlags, DEFAULT_FLAGS, overrides);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>
      <FeatureFlagsProvider>{children}</FeatureFlagsProvider>
    </QueryClientProvider>
  );
  return renderHook(() => useFeatureFlags(), { wrapper });
}

describe('feature-flag parent/child cascade (QA S9)', () => {
  it('turns Accounting (and its sub-features) off when Invoices is turned off', async () => {
    const { result } = renderFlags({
      quotes: true, bills: true, accounting: true, expenses: true, taxReport: true,
    });
    await waitFor(() => expect(result.current.staged.bills).toBe(true));

    act(() => result.current.setFlag('bills', false));

    expect(result.current.staged.bills).toBe(false);
    expect(result.current.staged.accounting).toBe(false);
    expect(result.current.staged.expenses).toBe(false);
    expect(result.current.staged.taxReport).toBe(false);
  });

  it('leaves a standalone Accounting alone when an unrelated flag is toggled', async () => {
    const { result } = renderFlags({ accounting: true, expenses: true });
    await waitFor(() => expect(result.current.staged.accounting).toBe(true));

    act(() => result.current.setFlag('workflows', true));

    expect(result.current.staged.accounting).toBe(true);
    expect(result.current.staged.expenses).toBe(true);
  });

  it('lets the admin keep Accounting standalone by re-enabling it before saving', async () => {
    const { result } = renderFlags({ quotes: true, bills: true, accounting: true });
    await waitFor(() => expect(result.current.staged.bills).toBe(true));

    act(() => result.current.setFlag('bills', false));
    act(() => result.current.setFlag('accounting', true));

    expect(result.current.staged.bills).toBe(false);
    expect(result.current.staged.accounting).toBe(true);
  });

  it('does not resurrect sub-features when Invoices is turned back on', async () => {
    const { result } = renderFlags({ quotes: true, bills: true, accounting: true, expenses: true });
    await waitFor(() => expect(result.current.staged.expenses).toBe(true));

    act(() => result.current.setFlag('bills', false));
    act(() => result.current.setFlag('bills', true));

    expect(result.current.staged.accounting).toBe(true); // forced back on by bills
    expect(result.current.staged.expenses).toBe(false);  // stays off until re-enabled
  });
});
