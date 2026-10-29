/**
 * The token form offers the gallery_passwords:* scopes (issue 2326) apart
 * from the read/write/admin ladder, with a warning, and sends the ticked ones
 * when the token is generated.
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({ t: (k: string, d?: unknown) => (typeof d === 'string' ? d : k) }),
}));
vi.mock('react-toastify', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('../../../../hooks/useLocalizedDate', () => ({
  useLocalizedDate: () => ({ formatDateTime: String, format: String }),
}));
vi.mock('../../../../config/api', () => ({ api: { get: vi.fn(), post: vi.fn(), delete: vi.fn() } }));
import { api } from '../../../../config/api';
import { ApiTokensTab } from '../ApiTokensTab';

describe('ApiTokensTab: gallery password scopes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.get).mockResolvedValue({ data: [] });
    vi.mocked(api.post).mockResolvedValue({ data: { token: 'pp_live_x' } });
  });

  it('offers both scopes, unticked, with a warning, and sends the ticked ones', async () => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ApiTokensTab />
      </QueryClientProvider>,
    );
    const readBox = await screen.findByRole('checkbox', { name: /gallery_passwords:read/ });
    const resetBox = screen.getByRole('checkbox', { name: /gallery_passwords:reset/ });
    expect(readBox).not.toBeChecked();
    expect(resetBox).not.toBeChecked();
    expect(screen.getByText(/They are not part of admin/)).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole('checkbox', { name: 'admin' }));
    expect(readBox).not.toBeChecked();
    await user.click(readBox);
    await user.type(screen.getByPlaceholderText('e.g. n8n production'), 'pw tool');
    await user.click(screen.getByRole('button', { name: 'Generate Token' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.post).mock.calls[0][1]).toEqual({ name: 'pw tool', scopes: ['read', 'admin', 'gallery_passwords:read'] });
  });
});
