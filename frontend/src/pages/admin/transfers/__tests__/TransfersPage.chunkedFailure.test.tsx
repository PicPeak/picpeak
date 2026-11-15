/**
 * A send created with a file too large for one request says what did not land.
 *
 * The service creates the send first and then uploads such a file in chunks
 * into it. When that fails the send exists without the file and its ready mail
 * is held; the page has to name the file and say the mail was not sent rather
 * than show a bare "Transfer created".
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { ConfirmDialogProvider } from '../../../../components/common';
import { TransfersPage } from '../TransfersPage';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({
      t: (_key: string, fallback?: any, vars?: Record<string, unknown>) => (typeof fallback === 'string'
        ? fallback.replace(/\{\{(\w+)\}\}/g, (_m, k) => String(vars?.[k] ?? '')) : _key),
    }),
  };
});

vi.mock('react-toastify', () => ({
  toast: { warn: vi.fn(), warning: vi.fn(), info: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

vi.mock('../../../../hooks/useLocalizedDate', () => ({
  useLocalizedDate: () => ({ formatDateTime: (v: string) => v, formatDate: (v: string) => v }),
}));
vi.mock('../../../../hooks/usePermission', () => ({ usePermission: () => true }));

vi.mock('../../../../services/transfers.service', () => ({
  transfersService: { list: vi.fn().mockResolvedValue([]), create: vi.fn() },
}));

import { toast } from 'react-toastify';
import { transfersService } from '../../../../services/transfers.service';

describe('create send with a large file', () => {
  it('names the file that did not land and says the mail was held', async () => {
    vi.mocked(transfersService.create).mockResolvedValue({
      id: 7, kind: 'send', rejected_files: [], dropped_files: [], failed_files: ['film.mp4'], delivery_held: true,
    } as never);
    const user = userEvent.setup();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <ConfirmDialogProvider>
          <TransfersPage />
        </ConfirmDialogProvider>
      </QueryClientProvider>,
    );

    await user.click(await screen.findByRole('button', { name: /send files/i }));
    const input = document.body.querySelector<HTMLInputElement>('input[type="file"]')!;
    const film = new File(['x'], 'film.mp4', { type: 'video/mp4' });
    fireEvent.change(input, { target: { files: [film] } });
    await user.click(await screen.findByRole('button', { name: /create transfer/i }));

    await waitFor(() => expect(transfersService.create).toHaveBeenCalledTimes(1));
    expect(vi.mocked(transfersService.create).mock.calls[0][0].files).toEqual([film]);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('film.mp4')));
    expect(toast.warn).toHaveBeenCalledWith(expect.stringContaining('was not sent'));
  });
});
