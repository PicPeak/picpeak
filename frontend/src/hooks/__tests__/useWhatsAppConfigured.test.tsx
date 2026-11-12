/**
 * The WhatsApp invite buttons show only when WhatsApp is set up: flag on and
 * the WhatsApp settings switched on, readable by this admin.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { useWhatsAppConfigured } from '../useWhatsAppConfigured';
import { whatsappService } from '../../services/whatsapp.service';

const state = vi.hoisted(() => ({ flag: true, canRead: true }));
vi.mock('../../contexts/FeatureFlagsContext', () => ({ useFeatureEnabled: () => state.flag }));
vi.mock('../usePermission', () => ({ useAnyPermission: () => state.canRead }));
vi.mock('../../services/whatsapp.service', () => ({ whatsappService: { getConfig: vi.fn() } }));

function run() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(() => useWhatsAppConfigured(), { wrapper });
}

describe('useWhatsAppConfigured', () => {
  beforeEach(() => {
    state.flag = true;
    state.canRead = true;
    vi.mocked(whatsappService.getConfig).mockReset().mockResolvedValue({ enabled: true } as never);
  });

  it('is true with the flag on and the WhatsApp settings switched on', async () => {
    const { result } = run();
    await waitFor(() => expect(result.current).toBe(true));
  });

  it('is false while the WhatsApp settings are switched off', async () => {
    vi.mocked(whatsappService.getConfig).mockResolvedValue({ enabled: false } as never);
    const { result } = run();
    await waitFor(() => expect(whatsappService.getConfig).toHaveBeenCalled());
    expect(result.current).toBe(false);
  });

  it('does not ask for the settings with the flag off, or without the right to read them', () => {
    state.flag = false;
    expect(run().result.current).toBe(false);
    state.flag = true;
    state.canRead = false;
    expect(run().result.current).toBe(false);
    expect(whatsappService.getConfig).not.toHaveBeenCalled();
  });
});
