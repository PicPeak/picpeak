/**
 * The customer email is optional at creation and can be cleared (issue 1733),
 * so an event may have nobody to resend the creation email to. The card
 * offers the button only when there is an address; the server would answer
 * 400 otherwise.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { ShareLinkCard } from '../ShareLinkCard';
import type { Event } from '../../../../types';

vi.mock('../../../../hooks/usePermission', () => ({ usePermission: () => true, useAnyPermission: () => true }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));
vi.mock('react-toastify', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../../../../services/events.service', () => ({
  eventsService: {
    getQrBlob: vi.fn().mockRejectedValue(new Error('no qr in tests')),
    getGalleryPassword: vi.fn(),
    getGalleryPasswordStatus: vi.fn().mockResolvedValue({ enabled: false }),
    resendCreationEmail: vi.fn(),
  },
}));

const baseEvent = {
  id: 9,
  slug: 'no-mail-wedding',
  event_name: 'No mail',
  share_link: '/gallery/no-mail-wedding/tok',
  require_password: true,
  client_access_enabled: false,
  is_archived: false,
} as unknown as Event;

function renderCard(event: Partial<Event>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ShareLinkCard event={{ ...baseEvent, ...event } as Event} setShowPasswordReset={() => {}} passwordVersion={0} />
    </QueryClientProvider>,
  );
}

describe('ShareLinkCard — resend needs a customer email', () => {
  it('hides the resend button when the event has no customer email', async () => {
    renderCard({ customer_email: null as unknown as string });
    expect(await screen.findByText('events.resetGalleryPassword')).toBeInTheDocument();
    expect(screen.queryByText('events.resendCreationEmail')).toBeNull();
  });

  it('shows it when there is an address', async () => {
    renderCard({ customer_email: 'anna@example.com' });
    expect(await screen.findByText('events.resendCreationEmail')).toBeInTheDocument();
  });
});
