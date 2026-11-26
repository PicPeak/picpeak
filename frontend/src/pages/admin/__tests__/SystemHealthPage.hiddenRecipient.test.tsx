/**
 * Stuck and waiting mail carry recipient null for an admin without
 * customers.view; both tables show a dash instead of an empty cell.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

const query = vi.hoisted(() => vi.fn());
vi.mock('@tanstack/react-query', () => ({ useQuery: query }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key) }) }));
vi.mock('../../../components/common', () => ({
  Card: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
  Button: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
  Loading: () => <span>Loading</span>,
}));
vi.mock('../../../hooks', () => ({ useMutationWithToast: () => ({ mutate: vi.fn(), isPending: false }) }));
vi.mock('../../../hooks/useLocalizedDate', () => ({ useLocalizedDate: () => ({ formatDateTime: String }) }));
vi.mock('../../../contexts/FeatureFlagsContext', () => ({ useFeatureFlags: () => ({ flags: {} }) }));
vi.mock('../../../contexts/PermissionsContext', () => ({ usePermissions: () => ({ hasPermission: () => true }) }));
vi.mock('../../../components/admin/DependencyStatusCard', () => ({ DependencyStatusCard: () => null }));
vi.mock('../../../services/systemHealth.service', () => ({ systemHealthService: {} }));

import { SystemHealthPage } from '../SystemHealthPage';

it('shows a dash for a hidden recipient in the stuck and waiting tables', () => {
  const row = { recipientEmail: null, status: 'failed', retryCount: 3, createdAt: '2027-01-10T10:00:00.000Z' };
  query.mockReturnValue({ isLoading: false, data: {
    stuckEmails: [{ ...row, id: 1, emailType: 'stuck_type', errorMessage: '550 <…>: mailbox unavailable' }],
    waitingEmails: [{ ...row, id: 2, emailType: 'waiting_type', status: 'pending', retryCount: 0, errorMessage: null }],
    counts: { stuckEmails: 1, waitingEmails: 1 },
  } });
  render(<SystemHealthPage />);
  for (const type of ['stuck_type', 'waiting_type']) {
    expect(screen.getByText(type).closest('tr')!.querySelector('td')!.textContent).toBe('—');
  }
  expect(screen.getByText('550 <…>: mailbox unavailable')).toBeInTheDocument();
});
