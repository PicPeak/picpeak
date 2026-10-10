/**
 * The incoming-mail fields save with the Email page's save bar (UX.md § 2):
 * the card has no Save button of its own, reports when its fields differ from
 * the server, and saves or discards through its handle.
 */
import { createRef } from 'react';
import { fireEvent, render, screen, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

import { IncomingMailConfigCard, type IncomingMailConfigHandle } from '../IncomingMailConfigCard';
import { emailService } from '../../../services/email.service';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return { ...actual, useTranslation: () => ({ t: (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key) }) };
});
vi.mock('react-toastify', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('../../../services/email.service', () => ({
  emailService: {
    getIncomingConfig: vi.fn(),
    updateIncomingConfig: vi.fn(),
  },
}));

const saved = { imap_host: 'imap.example.com', imap_port: 993, imap_secure: true, imap_user: 'in@example.com', imap_pass: '', imap_folder: 'INBOX' };

const setup = async () => {
  vi.mocked(emailService.getIncomingConfig).mockResolvedValue({ ...saved });
  vi.mocked(emailService.updateIncomingConfig).mockResolvedValue(undefined as never);
  const ref = createRef<IncomingMailConfigHandle>();
  const states: Array<{ dirty: boolean; saving: boolean }> = [];
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <IncomingMailConfigCard ref={ref} onStateChange={(s) => states.push(s)} />
    </QueryClientProvider>,
  );
  const host = await screen.findByDisplayValue('imap.example.com');
  return { ref, states, host };
};

describe('IncomingMailConfigCard — saves with the page', () => {
  it('has no Save button of its own and reports an edit as dirty', async () => {
    const { states, host } = await setup();
    expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument();
    await waitFor(() => expect(states.at(-1)).toEqual({ dirty: false, saving: false }));
    fireEvent.change(host, { target: { value: 'mail.example.com' } });
    await waitFor(() => expect(states.at(-1)?.dirty).toBe(true));
  });

  it('saves the edited fields through the handle', async () => {
    const { ref, host } = await setup();
    fireEvent.change(host, { target: { value: 'mail.example.com' } });
    let ok: boolean | undefined;
    await act(async () => { ok = await ref.current!.save(); });
    expect(ok).toBe(true);
    expect(emailService.updateIncomingConfig).toHaveBeenCalledWith(expect.objectContaining({ imap_host: 'mail.example.com' }));
  });

  it('discard puts the saved values back', async () => {
    const { ref, states, host } = await setup();
    fireEvent.change(host, { target: { value: 'mail.example.com' } });
    act(() => ref.current!.discard());
    await waitFor(() => expect(states.at(-1)?.dirty).toBe(false));
    expect(screen.getByDisplayValue('imap.example.com')).toBeInTheDocument();
  });
});
