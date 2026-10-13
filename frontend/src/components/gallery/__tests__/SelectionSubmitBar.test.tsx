/**
 * "x of y selected", Finish selection and Approve edited photos (issue 1733,
 * backlog item A1).
 *
 * The counter reads the like cap or the favourites cap, whichever the gallery
 * uses, and plain "x selected" without one. Each hand-over asks first, because
 * it locks that part of the guest's feedback, and afterwards the bar says when
 * it was handed in instead of offering the button again.
 */
import { render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

import { SelectionSubmitBar, useSelectionPickRefresh } from '../SelectionSubmitBar';
import { FEEDBACK_SUBMITTED_EVENT } from '../../../utils/feedbackEvents';
import { toast } from 'react-toastify';
import type { SelectionState } from '../../../services/feedback.service';
import { feedbackLockKind } from '../../../utils/feedbackLock';
import { parseFeedbackLimitError } from '../../../hooks/useFeedbackLimitModal';

const submitSelection = vi.fn();
// null outside a GuestIdentityProvider, as in a gallery without the provider.
const guestIdentity: { current: null | { identityMode: 'guest' | 'simple'; ensureIdentity: () => Promise<unknown> } } = { current: null };

vi.mock('../../../contexts/GuestIdentityContext', () => ({
  useGuestIdentityOptional: () => guestIdentity.current,
}));

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, fallback?: unknown, options?: Record<string, unknown>) =>
        (typeof fallback === 'string' ? fallback : key)
          .replace(/\{\{(\w+)\}\}/g, (_m, name) => String(options?.[name] ?? '')),
      i18n: { language: 'en' },
    }),
  };
});

vi.mock('../../../services/feedback.service', async () => {
  const actual = await vi.importActual<any>('../../../services/feedback.service');
  return {
    ...actual,
    feedbackService: { submitSelection: (...args: unknown[]) => submitSelection(...args) },
  };
});

vi.mock('../../../hooks/useLocalizedDate', () => ({
  useLocalizedDate: () => ({ format: (date: string) => `on:${date.slice(0, 10)}` }),
}));

vi.mock('react-toastify', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const wrapper = ({ children }: { children: ReactNode }) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
};

const state = (patch: {
  selection?: Partial<SelectionState['selection']>;
  approval?: Partial<SelectionState['approval']>;
} = {}): SelectionState => ({
  selection: { counter: true, can_submit: true, pick_types: ['like'], cap: null, used: 0, submission: null, ...patch.selection },
  approval: { can_submit: false, approved: 0, rejected: 0, submission: null, ...patch.approval },
});

const renderBar = (value: SelectionState | undefined, used = 0) =>
  render(<SelectionSubmitBar slug="g" state={value} used={used} />, { wrapper });

describe('SelectionSubmitBar (issue 1733)', () => {
  beforeEach(() => {
    submitSelection.mockReset();
    guestIdentity.current = null;
  });

  it('renders nothing until the state is known, or when the gallery has neither', () => {
    const { container, rerender } = renderBar(undefined);
    expect(container).toBeEmptyDOMElement();
    rerender(<SelectionSubmitBar slug="g" used={0} state={state({ selection: { counter: false, can_submit: false } })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('counts against the cap, and plainly without one', () => {
    const { rerender } = renderBar(state({ selection: { cap: 10 } }), 3);
    expect(screen.getByTestId('selection-counter')).toHaveTextContent('3 of 10 selected');
    rerender(<SelectionSubmitBar slug="g" used={4} state={state()} />);
    expect(screen.getByTestId('selection-counter')).toHaveTextContent('4 selected');
  });

  it('shows the counter without a button when only a cap is set', () => {
    renderBar(state({ selection: { cap: 5, can_submit: false } }), 1);
    expect(screen.getByTestId('selection-counter')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Finish selection' })).not.toBeInTheDocument();
  });

  it('has nothing to finish while nothing is selected', () => {
    renderBar(state(), 0);
    expect(screen.getByRole('button', { name: 'Finish selection' })).toBeDisabled();
  });

  it('asks before finishing, then sends the selection with the note', async () => {
    submitSelection.mockResolvedValue({ id: 1, kind: 'selection', submitted_at: '2026-10-12T10:00:00.000Z', item_count: 2, note: 'Album' });
    renderBar(state(), 2);

    await userEvent.click(screen.getByRole('button', { name: 'Finish selection' }));
    const dialog = screen.getByRole('dialog', { name: 'Finish your selection?' });
    expect(screen.getByTestId('selection-finish-count')).toHaveTextContent('Selected photos: 2');
    expect(submitSelection).not.toHaveBeenCalled();

    await userEvent.type(screen.getByLabelText('Note for the photographer (optional)'), 'Album');
    await userEvent.click(Array.from(dialog.querySelectorAll('button')).find((b) => b.textContent === 'Finish selection')!);

    await waitFor(() => expect(submitSelection).toHaveBeenCalledWith('g', 'selection', 'Album'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('cancelling sends nothing', async () => {
    renderBar(state(), 2);
    await userEvent.click(screen.getByRole('button', { name: 'Finish selection' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(submitSelection).not.toHaveBeenCalled();
  });

  it('in guest identity mode asks for the name before the confirmation, not behind it', async () => {
    let answer!: { resolve: (value: unknown) => void; reject: (reason: Error) => void };
    const ensureIdentity = vi.fn(() => new Promise((resolve, reject) => { answer = { resolve, reject }; }));
    guestIdentity.current = { identityMode: 'guest', ensureIdentity };
    renderBar(state({ approval: { can_submit: true } }), 0);

    // The name prompt is open: no confirmation on top of it yet.
    await userEvent.click(screen.getByRole('button', { name: 'Approve edited photos' }));
    expect(ensureIdentity).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    // Dismissed: nothing opens.
    answer.reject(new Error('user_cancelled'));
    await waitFor(() => expect(ensureIdentity).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    // Answered: now the confirmation.
    await userEvent.click(screen.getByRole('button', { name: 'Approve edited photos' }));
    answer.resolve({ id: 7, name: 'Anna' });
    expect(await screen.findByRole('dialog', { name: 'Approve the edited photos?' })).toBeInTheDocument();
    expect(submitSelection).not.toHaveBeenCalled();
  });

  it('says so when the request never got an answer', async () => {
    // Offline or timed out: an axios error without a response.
    submitSelection.mockRejectedValue(new Error('Network Error'));
    renderBar(state({ approval: { can_submit: true } }), 0);
    await userEvent.click(screen.getByRole('button', { name: 'Approve edited photos' }));
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not send it. Please try again.'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('refreshes the picks after any stored like or favourite of this gallery', () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const send = (detail: { slug: string; feedback_type: string }) =>
      window.dispatchEvent(new CustomEvent(FEEDBACK_SUBMITTED_EVENT, { detail }));
    const { rerender } = renderHook(({ on }) => useSelectionPickRefresh('g', on), {
      initialProps: { on: true },
      wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
    });

    send({ slug: 'g', feedback_type: 'like' });
    send({ slug: 'g', feedback_type: 'favorite' });
    expect(invalidate).toHaveBeenCalledTimes(2);
    expect(invalidate).toHaveBeenLastCalledWith({ queryKey: ['my-feedback', 'g'] });

    // Not a pick, another gallery, or no counter to feed.
    send({ slug: 'g', feedback_type: 'rating' });
    send({ slug: 'other', feedback_type: 'like' });
    rerender({ on: false });
    send({ slug: 'g', feedback_type: 'like' });
    expect(invalidate).toHaveBeenCalledTimes(2);
  });

  it('shows a finished selection with its date instead of the button', () => {
    renderBar(state({
      selection: { submission: { id: 1, kind: 'selection', submitted_at: '2026-10-11T09:00:00.000Z', item_count: 3, note: null } },
    }), 3);
    expect(screen.getByTestId('selection-submitted')).toHaveTextContent('Selection finished on on:2026-10-11. Your picks are locked.');
    expect(screen.queryByRole('button', { name: 'Finish selection' })).not.toBeInTheDocument();
  });

  it('offers the approval only where the gallery takes one, and warns about rejected photos', async () => {
    submitSelection.mockResolvedValue({ id: 2, kind: 'approval', submitted_at: '2026-10-12T10:00:00.000Z', item_count: 4, note: null });
    const { rerender } = renderBar(state(), 1);
    expect(screen.queryByRole('button', { name: 'Approve edited photos' })).not.toBeInTheDocument();

    rerender(<SelectionSubmitBar slug="g" used={1} state={state({ approval: { can_submit: true, approved: 4, rejected: 1 } })} />);
    await userEvent.click(screen.getByRole('button', { name: 'Approve edited photos' }));
    expect(screen.getByRole('dialog', { name: 'Approve the edited photos?' })).toHaveTextContent('Photos still marked as rejected: 1');
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(submitSelection).toHaveBeenCalledWith('g', 'approval', ''));
  });

  it('shows an approval with its date once given', () => {
    renderBar(state({
      selection: { counter: false, can_submit: false },
      approval: { can_submit: true, submission: { id: 2, kind: 'approval', submitted_at: '2026-10-12T10:00:00.000Z', item_count: 4, note: null } },
    }));
    expect(screen.getByTestId('approval-submitted')).toHaveTextContent('Edited photos approved on on:2026-10-12');
    expect(screen.queryByRole('button', { name: 'Approve edited photos' })).not.toBeInTheDocument();
  });
});

describe('a locked pick explains itself (issue 1733)', () => {
  const refusal = (status: number, code: string) => ({ response: { status, data: { code } } });

  it('recognises the two lock refusals and nothing else', () => {
    expect(feedbackLockKind(refusal(409, 'SELECTION_LOCKED'))).toBe('selection');
    expect(feedbackLockKind(refusal(409, 'APPROVAL_LOCKED'))).toBe('approval');
    expect(feedbackLockKind(refusal(409, 'ALREADY_SUBMITTED'))).toBeNull();
    expect(feedbackLockKind(refusal(403, 'LIKE_LIMIT_REACHED'))).toBeNull();
    expect(feedbackLockKind(new Error('network'))).toBeNull();
    // And it is not mistaken for the cap modal's error.
    expect(parseFeedbackLimitError(refusal(409, 'SELECTION_LOCKED'))).toBeNull();
  });
});
