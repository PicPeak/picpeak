/**
 * Finished selections and approvals in the gallery's feedback area (issue
 * 1733, backlog item A1): one line per guest and kind, and Reopen, which asks
 * first and is gone once the submission is reopened.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

import { SelectionSubmissionsCard } from '../SelectionSubmissionsCard';

const getSelectionSubmissions = vi.fn();
const reopenSelectionSubmission = vi.fn();
const confirm = vi.fn();
let mayReopen = true;

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

vi.mock('../../../services/feedback.service', () => ({
  feedbackService: {
    getSelectionSubmissions: (...args: unknown[]) => getSelectionSubmissions(...args),
    reopenSelectionSubmission: (...args: unknown[]) => reopenSelectionSubmission(...args),
  },
}));

vi.mock('../../common', async () => {
  const actual = await vi.importActual<any>('../../common');
  return { ...actual, useConfirm: () => confirm };
});

vi.mock('../../../hooks/useLocalizedDate', () => ({
  useLocalizedDate: () => ({ formatDateTime: (date: string) => date.slice(0, 10) }),
}));

vi.mock('../../../hooks/usePermission', () => ({ useAnyPermission: () => mayReopen }));

vi.mock('react-toastify', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const wrapper = ({ children }: { children: ReactNode }) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
};

const submissions = [
  { id: 7, kind: 'selection', guest_id: 3, guest_name: 'Anna', item_count: 12, note: 'Album, please', submitted_at: '2026-10-11T09:00:00.000Z', reopened_at: null },
  { id: 5, kind: 'approval', guest_id: null, guest_name: null, item_count: 4, note: null, submitted_at: '2026-10-10T09:00:00.000Z', reopened_at: '2026-10-10T12:00:00.000Z' },
];

describe('SelectionSubmissionsCard (issue 1733)', () => {
  beforeEach(() => {
    getSelectionSubmissions.mockReset().mockResolvedValue(submissions);
    reopenSelectionSubmission.mockReset().mockResolvedValue({ success: true });
    confirm.mockReset();
    mayReopen = true;
  });

  it('renders nothing while no guest has submitted', async () => {
    getSelectionSubmissions.mockResolvedValue([]);
    const { container } = render(<SelectionSubmissionsCard eventId="9" />, { wrapper });
    await waitFor(() => expect(getSelectionSubmissions).toHaveBeenCalledWith('9'));
    expect(container).toBeEmptyDOMElement();
  });

  it('lists each submission with guest, kind, count, date and note', async () => {
    render(<SelectionSubmissionsCard eventId="9" />, { wrapper });
    const rows = await screen.findAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('Anna');
    expect(rows[0]).toHaveTextContent('Selection');
    expect(rows[0]).toHaveTextContent('Photos: 12');
    expect(rows[0]).toHaveTextContent('Submitted 2026-10-11');
    expect(rows[0]).toHaveTextContent('Note: Album, please');
    expect(rows[1]).toHaveTextContent('Anonymous');
    expect(rows[1]).toHaveTextContent('Approval of the edited photos');
    expect(rows[1]).toHaveTextContent('Reopened 2026-10-10');
    // Only the active one can be reopened.
    expect(screen.getAllByRole('button', { name: 'Reopen' })).toHaveLength(1);
  });

  it('reopens after confirmation only', async () => {
    render(<SelectionSubmissionsCard eventId="9" />, { wrapper });
    const button = await screen.findByRole('button', { name: 'Reopen' });

    confirm.mockResolvedValueOnce(false);
    await userEvent.click(button);
    expect(reopenSelectionSubmission).not.toHaveBeenCalled();

    confirm.mockResolvedValueOnce(true);
    await userEvent.click(button);
    await waitFor(() => expect(reopenSelectionSubmission).toHaveBeenCalledWith('9', 7));
  });

  it('hides Reopen from a role that may not help guests', async () => {
    mayReopen = false;
    render(<SelectionSubmissionsCard eventId="9" />, { wrapper });
    await screen.findAllByRole('listitem');
    expect(screen.queryByRole('button', { name: 'Reopen' })).not.toBeInTheDocument();
  });
});
