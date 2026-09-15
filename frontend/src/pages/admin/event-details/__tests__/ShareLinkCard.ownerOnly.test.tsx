/**
 * The API withholds another owner's gallery links from an admin who can read
 * the event but not act on it (`share_secrets_hidden`). The card says so
 * instead of offering a "#" link and a copy button that can only fail.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { ShareLinkCard } from '../ShareLinkCard';
import type { Event } from '../../../../types';

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
  slug: 'other-owner-wedding',
  event_name: 'Other owner',
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

describe('ShareLinkCard — links withheld for another owner\'s gallery', () => {
  it('explains that only the owner can share the link, with no link field or copy button', async () => {
    renderCard({ share_secrets_hidden: true });

    expect(await screen.findByText('events.shareLinkOwnerOnly')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByText('events.copy')).toBeNull();
    expect(screen.queryByDisplayValue('#')).toBeNull();
  });

  it('still shows the link and copy button for an event the admin can act on', async () => {
    renderCard({ share_link: '/gallery/other-owner-wedding/tok' });

    await waitFor(() => expect((screen.getByRole('textbox') as HTMLInputElement).value).toContain('/gallery/other-owner-wedding/tok'));
    expect(screen.getByText('events.copy')).toBeInTheDocument();
    expect(screen.queryByText('events.shareLinkOwnerOnly')).toBeNull();
  });
});
