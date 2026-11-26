/**
 * An admin without customers.view gets mail recipients as null and addresses
 * in delivery errors as `…`. The Sent list, its search and the reading pane
 * must show that cleanly: a dash, no "null", no crash.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

const item = {
  id: 1, recipientEmail: null, emailType: 'gallery_created', status: 'failed', createdAt: '2027-01-10T10:00:00.000Z',
  scheduledAt: null, sentAt: null, errorMessage: '550 <…>: mailbox unavailable', retryCount: 3,
  eventId: 7, eventName: 'Redact', eventSlug: 'redact', origin: 'system',
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback?: string) => fallback ?? _key }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));
vi.mock('../../../../contexts/FeatureFlagsContext', () => ({ useFeatureFlags: () => ({ flags: {} }) }));
vi.mock('../../../../hooks/usePermission', () => ({ usePermission: () => false }));
vi.mock('../../../../services/accounting.service', () => ({ accountingService: {} }));
vi.mock('../../../../services/email.service', () => ({
  emailService: {
    listQueue: vi.fn(async () => ({ items: [item], pagination: { total: 1, page: 1, pageSize: 100, totalPages: 1 } })),
    listReceived: vi.fn(async () => ({ items: [], pagination: { total: 0, page: 1, pageSize: 100, totalPages: 1 } })),
    getIdentities: vi.fn(async () => ({ automated: 'noreply@studio.example', customers: null, accounting: null })),
    getQueueItem: vi.fn(async () => ({ ...item, renderedHtml: null, cc: null, attachments: [] })),
  },
}));

import MessagesPage from '../MessagesPage';

describe('MessagesPage with a hidden recipient', () => {
  it('lists, searches and opens the mail without showing or crashing on null', async () => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter><MessagesPage /></MemoryRouter>
      </QueryClientProvider>,
    );

    const row = await screen.findByText('Gallery Created');
    const button = row.closest('button') as HTMLElement;
    expect(within(button).getByText('—')).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('Search this folder…'), { target: { value: 'gallery' } });
    expect(await screen.findByText('Gallery Created')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Gallery Created').closest('button') as HTMLElement);
    const header = (await screen.findByRole('heading', { level: 2, name: 'Gallery Created' })).nextElementSibling as HTMLElement;
    expect(header.textContent).toMatch(/to\s*—/);
    expect(document.body.textContent).not.toContain('null');
  });
});
