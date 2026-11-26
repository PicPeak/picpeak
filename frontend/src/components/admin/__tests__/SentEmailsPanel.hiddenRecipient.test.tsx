/**
 * The email log blanks the recipient (null) for an admin without
 * customers.view; the table shows a dash instead of an empty cell.
 */
import { expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback?: string) => fallback ?? _key }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));
vi.mock('../../../hooks/useLocalizedDate', () => ({ useLocalizedDate: () => ({ formatDateTime: (d: string) => d }) }));
vi.mock('../../../services/email.service', () => ({
  emailService: {
    listQueue: vi.fn(async () => ({
      items: [{
        id: 1, recipientEmail: null, emailType: 'gallery_created', status: 'failed', createdAt: '2027-01-10T10:00:00.000Z',
        scheduledAt: null, sentAt: null, errorMessage: '550 <…>: mailbox unavailable', retryCount: 3,
        eventId: null, eventName: null, eventSlug: null,
      }],
      pagination: { total: 1, page: 1, pageSize: 25, totalPages: 1 },
    })),
  },
}));

import { SentEmailsPanel } from '../SentEmailsPanel';

it('shows a dash for a hidden recipient', async () => {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter><SentEmailsPanel /></MemoryRouter>
    </QueryClientProvider>,
  );
  const cell = (await screen.findByText('gallery_created')).closest('tr')!.querySelector('td')!;
  expect(cell.textContent).toBe('—');
  expect(screen.getByText('550 <…>: mailbox unavailable')).toBeInTheDocument();
});
