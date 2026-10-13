/**
 * The Passkeys card reads from its status whether adding a passkey needs an
 * authenticator code (issue 1733). Switching two-factor authentication off in
 * the card next to it must refresh that status: otherwise the Passkeys card
 * keeps asking for a code from the factor that was just removed.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en' } }),
  };
});

vi.mock('react-toastify', () => ({
  toast: { success: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('../../../components/common', async () => {
  const actual = await vi.importActual<typeof import('../../../components/common')>('../../../components/common');
  return { ...actual, useConfirm: () => async () => true };
});

const service = vi.hoisted(() => ({
  getStatus: vi.fn(),
  setup: vi.fn(),
  enable: vi.fn(),
  disable: vi.fn(),
  regenerateRecoveryCodes: vi.fn(),
}));
vi.mock('../../../services/mfa.service', () => ({ mfaService: service }));

import { MfaSettingsCard } from '../components/MfaSettingsCard';

beforeEach(() => {
  vi.spyOn(window, 'prompt').mockReturnValue('123456');
});
afterEach(() => {
  vi.restoreAllMocks();
  Object.values(service).forEach((fn) => fn.mockReset());
});

describe('MfaSettingsCard and the passkey status', () => {
  it('marks the passkey status stale when two-factor authentication is switched off', async () => {
    service.getStatus.mockResolvedValue({ enabled: true, enrolledAt: '2026-10-01T10:00:00.000Z', recoveryCodesRemaining: 8 });
    service.disable.mockResolvedValue({ message: 'ok' });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(['admin-passkeys'], { mfaEnabled: true, passkeys: [] });
    render(
      <QueryClientProvider client={qc}>
        <MfaSettingsCard />
      </QueryClientProvider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'settings.mfa.disable' }));
    await waitFor(() => expect(service.disable).toHaveBeenCalledWith('123456'));
    await waitFor(() => expect(qc.getQueryState(['admin-passkeys'])?.isInvalidated).toBe(true));
  });
});
