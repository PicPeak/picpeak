/**
 * "Keep prepared downloads for (hours)" (issue 1733): the field saves the
 * number that was typed, and nothing outside 1 to 168 whole hours.
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
vi.mock('../../../../config/api', () => ({ api: { get: vi.fn(), put: vi.fn() } }));
import { api } from '../../../../config/api';
import { DownloadsTab } from '../DownloadsTab';

const stored = {
  standard_resolution: 'original',
  picker_enabled: true,
  allow_original: false,
  resolutions: [{ id: '1500x1000', label: 'Medium', width: 1500, height: 1000 }],
  job_retention_hours: 1,
};

async function open() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <DownloadsTab />
    </QueryClientProvider>,
  );
  const field = await screen.findByLabelText('Keep prepared downloads for (hours)');
  expect(field).toHaveValue(1);
  return { user: userEvent.setup(), field };
}
const saveButton = () => screen.getByRole('button', { name: /save/i });

describe('DownloadsTab: retention of prepared downloads', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.get).mockResolvedValue({ data: stored });
    vi.mocked(api.put).mockResolvedValue({ data: {} });
  });

  it('saves the hours that were typed', async () => {
    const { user, field } = await open();
    await user.clear(field);
    await user.type(field, '48');
    await user.click(saveButton());
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.put).mock.calls[0][1]).toMatchObject({ download_job_retention_hours: 48 });
  });

  it.each(['2.5', '0', '169', ''])('does not offer to save %j', async (text) => {
    const { user, field } = await open();
    await user.clear(field);
    if (text) await user.type(field, text);
    expect(saveButton()).toBeDisabled();
    expect(api.put).not.toHaveBeenCalled();
  });

  it('warns that keeping downloads longer costs disk space', async () => {
    await open();
    expect(screen.getByText(/disk space/)).toBeInTheDocument();
  });
});
