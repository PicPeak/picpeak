/**
 * The Events tab loads the maximum lightbox zoom (issue 2281) with the
 * backend's fallback: anything but an integer from 100 to 1000 is 100.
 */
import React from 'react';
import { expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
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

const loadPercent = async (value: unknown) => {
  for (const key of Object.keys(stored)) delete stored[key];
  stored.gallery_lightbox_max_zoom_percent = value;
  stored.general_default_expiration_days = 30;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { result } = renderHook(() => useSettingsState(), {
    wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  });
  await waitFor(() => expect(result.current.isLoading).toBe(false));
  await waitFor(() => expect(result.current.eventSettings.gallery_lightbox_max_zoom_percent).toBe(expected(value)));
};
const expected = (value: unknown) => (value === 800 || value === '800' ? 800 : 100);

it.each([800, '800'])('loads a stored maximum lightbox zoom of %s', async (value) => {
  await loadPercent(value);
});

// An out-of-range value the gallery ignores (it zooms to 100 %) must not show
// as 1000 and then be saved over the ignored value with the next Events save.
it.each([5000, 50, 250.5, 'abc'])('shows the 100 the gallery uses for a stored %s', async (value) => {
  await loadPercent(value);
});
