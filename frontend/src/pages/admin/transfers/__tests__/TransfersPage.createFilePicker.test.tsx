/**
 * The create dialog keeps the files picked from the "Choose files" input.
 *
 * The input's onChange passed the live FileList into a setFiles updater and
 * then cleared the input. Clearing empties that same FileList, and React may
 * run the updater only on the next render, so the picked files were dropped
 * and "Create transfer" stayed disabled. It showed once the dialog had
 * re-rendered, e.g. after typing a title — how many characters it took varies.
 */
import { fireEvent, render, screen } from '@testing-library/react';
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
      t: (_key: string, fallback?: any) => (typeof fallback === 'string' ? fallback : _key),
    }),
  };
});

vi.mock('react-toastify', () => ({
  toast: { warning: vi.fn(), info: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

vi.mock('../../../../hooks/useLocalizedDate', () => ({
  useLocalizedDate: () => ({ formatDateTime: (v: string) => v, formatDate: (v: string) => v }),
}));

vi.mock('../../../../services/transfers.service', () => ({
  transfersService: { list: vi.fn().mockResolvedValue([]), create: vi.fn() },
}));

/**
 * Pick files the way a browser does: `files` is one live list that clearing
 * the input's value empties in place.
 */
function pickFiles(input: HTMLInputElement, files: File[]) {
  const live: File[] = [...files];
  const fileList = {
    get length() { return live.length; },
    item: (i: number) => live[i] ?? null,
    [Symbol.iterator]: () => live[Symbol.iterator](),
  };
  Object.defineProperty(input, 'files', { configurable: true, get: () => fileList });
  Object.defineProperty(input, 'value', {
    configurable: true,
    get: () => (live.length ? `C:\\fakepath\\${live[0].name}` : ''),
    set: (v: string) => { if (v === '') live.length = 0; },
  });
  fireEvent.change(input);
}

describe('create transfer dialog file picker', () => {
  it.each(['', 'L', 'LB', 'LBM Logos'])('keeps the picked files with title %j', async (title) => {
    const user = userEvent.setup();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <ConfirmDialogProvider>
          <TransfersPage />
        </ConfirmDialogProvider>
      </QueryClientProvider>,
    );

    await user.click(await screen.findByRole('button', { name: /new transfer/i }));
    if (title) await user.type(screen.getByPlaceholderText(/wedding finals/i), title);

    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    pickFiles(input, [
      new File(['<svg/>'], 'LBM_Logo_sqr.svg', { type: 'image/svg+xml' }),
      new File(['<svg/>'], 'LBM_Logo_sqr_boxed.svg', { type: 'image/svg+xml' }),
    ]);

    expect(await screen.findByText('LBM_Logo_sqr.svg')).toBeInTheDocument();
    expect(screen.getByText('LBM_Logo_sqr_boxed.svg')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create transfer/i })).toBeEnabled();
  });
});
