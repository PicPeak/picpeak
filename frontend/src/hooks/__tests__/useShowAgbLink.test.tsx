/**
 * The AGB footer link is opt-in: it shows only once the admin switched the
 * page on (show_in_footer === true) — not while it loads, not while it is
 * switched off, and not when the install has no AGB page.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const cms = vi.hoisted(() => ({ getPublicPage: vi.fn() }));
vi.mock('../../services/cms.service', () => ({ cmsService: cms }));

import { useShowAgbLink } from '../useShowAgbLink';

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
);

describe('useShowAgbLink', () => {
  beforeEach(() => { cms.getPublicPage.mockReset(); });

  it('shows the link once the page is switched on', async () => {
    cms.getPublicPage.mockResolvedValue({ slug: 'agb', show_in_footer: true });
    const { result } = renderHook(() => useShowAgbLink(), { wrapper });
    expect(result.current).toBe(false);
    await waitFor(() => expect(result.current).toBe(true));
    expect(cms.getPublicPage).toHaveBeenCalledWith('agb');
  });

  it('hides it while the page is switched off', async () => {
    cms.getPublicPage.mockResolvedValue({ slug: 'agb', show_in_footer: false });
    const { result } = renderHook(() => useShowAgbLink(), { wrapper });
    await waitFor(() => expect(cms.getPublicPage).toHaveBeenCalled());
    expect(result.current).toBe(false);
  });

  it('hides it while the page is still loading', () => {
    cms.getPublicPage.mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useShowAgbLink(), { wrapper });
    expect(result.current).toBe(false);
  });

  it('hides it when the page cannot be loaded', async () => {
    cms.getPublicPage.mockRejectedValue(new Error('Page not found'));
    const client = new QueryClient();
    const { result } = renderHook(() => useShowAgbLink(), {
      wrapper: ({ children }: { children: React.ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    });
    await waitFor(() => expect(client.getQueryState(['public-cms', 'agb'])?.status).toBe('error'));
    expect(result.current).toBe(false);
  });
});
