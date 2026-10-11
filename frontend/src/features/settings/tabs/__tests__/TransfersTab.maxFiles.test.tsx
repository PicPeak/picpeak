/**
 * The "Maximum files per upload" field saves the number that was typed.
 *
 * A number input reports an empty value while "1e2" is half typed. The field
 * was converted to a number on every keystroke, so that intermediate state
 * rewrote it to 0 and finishing the entry left 2: the wrong global limit,
 * and saveable. The field keeps its text and is parsed as a whole.
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
vi.mock('../../../../hooks/usePermission', () => ({ usePermission: () => true }));
vi.mock('../../../../config/api', () => ({ api: { get: vi.fn(), put: vi.fn() } }));
import { api } from '../../../../config/api';
import { TransfersTab } from '../TransfersTab';

const stored = { accept_all: true, allowed_types: [], max_size_mb: 50, max_files: 25 };

async function open() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TransfersTab />
    </QueryClientProvider>,
  );
  const field = await screen.findByLabelText('Maximum files per upload');
  expect(field).toHaveValue(25);
  return { user: userEvent.setup(), field };
}
const saveButton = () => screen.getByRole('button', { name: /save/i });

describe('TransfersTab: maximum files per upload', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.get).mockResolvedValue({ data: stored });
    vi.mocked(api.put).mockResolvedValue({ data: {} });
  });

  it('saves 1e2 as one hundred', async () => {
    const { user, field } = await open();
    await user.clear(field);
    await user.type(field, '1e2');
    await user.click(saveButton());
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.put).mock.calls[0][1]).toMatchObject({ max_files: 100 });
  });

  it.each(['2.5', '0', '1001', ''])('does not offer to save %j', async (text) => {
    const { user, field } = await open();
    await user.clear(field);
    if (text) await user.type(field, text);
    expect(saveButton()).toBeDisabled();
    expect(api.put).not.toHaveBeenCalled();
  });
});
