/**
 * `analytics_custom_head_html` is a super-admin-only key on the backend. The
 * Analytics tab must not post it at all: a blank sent over a stale stored
 * snippet 403'd the whole save for a delegated settings.edit admin.
 */
import React from 'react';
import { expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return { ...actual, useTranslation: () => ({ t: (k: string) => k }) };
});
vi.mock('react-toastify', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../../../../contexts', () => ({ useAdminAuth: () => ({ updateUserProfile: vi.fn() }) }));
const updateSettings = vi.fn(async (_data: Record<string, unknown>) => ({}));
const stored: Record<string, unknown> = {};
vi.mock('../../../../services/settings.service', () => ({
  settingsService: {
    getAllSettings: async () => stored,
    updateSettings: (data: Record<string, unknown>) => updateSettings(data),
  },
}));
vi.mock('../../../../services/admin.service', () => ({
  adminService: { getAdminProfile: async () => ({}) },
}));

import { useSettingsState } from '../useSettingsState';

it.each(['umami', 'rybbit', 'none', 'custom'])('never posts the legacy snippet key when saving provider %s', async (provider) => {
  updateSettings.mockClear();
  Object.assign(stored, {
    analytics_tracker_provider: provider,
    analytics_custom_head_html: '<script>window.__stale = true</script>',
    analytics_umami_website_id: 'site-1',
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { result } = renderHook(() => useSettingsState(), {
    wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  });
  await waitFor(() => expect(result.current.analyticsSettings.umami_website_id).toBe('site-1'));
  act(() => { result.current.saveAnalyticsMutation.mutate(); });
  await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
  const sent = updateSettings.mock.calls[0][0];
  expect(sent).not.toHaveProperty('analytics_custom_head_html');
  expect(JSON.stringify(sent)).not.toContain('__stale');
  expect(sent.analytics_tracker_provider).toBe(provider);
  expect(sent.analytics_umami_website_id).toBe('site-1');
});
