import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { usePublicSettings } from '../usePublicSettings';
import { publicSettingsService } from '../../services/publicSettings.service';

vi.mock('../../services/publicSettings.service', () => ({
  publicSettingsService: {
    getPublicSettings: vi.fn(),
  },
}));

const getPublicSettingsMock = vi.mocked(publicSettingsService.getPublicSettings);

function makeWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, Wrapper };
}

describe('usePublicSettings', () => {
  beforeEach(() => {
    getPublicSettingsMock.mockReset();
  });

  it('returns settings from the public settings service', async () => {
    getPublicSettingsMock.mockResolvedValue({
      branding_company_name: 'PicPeak Test',
      maintenance_mode: false,
    } as Awaited<ReturnType<typeof publicSettingsService.getPublicSettings>>);

    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => usePublicSettings(), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.branding_company_name).toBe('PicPeak Test');
    expect(getPublicSettingsMock).toHaveBeenCalledTimes(1);
  });

  it('dedupes parallel callers in the same QueryClient', async () => {
    getPublicSettingsMock.mockResolvedValue({
      branding_company_name: 'PicPeak Test',
    } as Awaited<ReturnType<typeof publicSettingsService.getPublicSettings>>);

    const { Wrapper } = makeWrapper();
    const { result: first } = renderHook(() => usePublicSettings(), { wrapper: Wrapper });
    const { result: second } = renderHook(() => usePublicSettings(), { wrapper: Wrapper });
    const { result: third } = renderHook(() => usePublicSettings(), { wrapper: Wrapper });

    await waitFor(() => {
      expect(first.current.isSuccess).toBe(true);
      expect(second.current.isSuccess).toBe(true);
      expect(third.current.isSuccess).toBe(true);
    });

    // Single network call regardless of how many components mount the hook.
    expect(getPublicSettingsMock).toHaveBeenCalledTimes(1);
  });
});
