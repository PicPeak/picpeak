/**
 * Client login needs the private link as well as the PIN. A gallery whose PIN
 * predates the link has no token, so the card keeps the control that mints one
 * instead of hiding it together with the link field.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { ClientAccessCard } from '../ClientAccessCard';
import type { Event } from '../../../../types';

const mocks = vi.hoisted(() => ({ updateEvent: vi.fn() }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));
vi.mock('react-toastify', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../../../../services/events.service', () => ({
  eventsService: { updateEvent: mocks.updateEvent },
}));

const baseEvent = {
  id: 9,
  slug: 'client-gallery',
  client_access_enabled: true,
  is_archived: false,
} as unknown as Event;

function renderCard(event: Partial<Event>, refetchEvent = vi.fn()) {
  render(<ClientAccessCard event={{ ...baseEvent, ...event } as Event} refetchEvent={refetchEvent} />);
  return refetchEvent;
}

describe('ClientAccessCard link control', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateEvent.mockResolvedValue({});
  });

  it('offers the link control when client access is on but no link exists', async () => {
    const refetchEvent = renderCard({ client_share_token: undefined });

    expect(screen.queryByText('clientAccess.linkLabel')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'clientAccess.regenerateToken' }));

    await waitFor(() => expect(mocks.updateEvent).toHaveBeenCalledWith(9, { regenerate_client_token: true }));
    await waitFor(() => expect(refetchEvent).toHaveBeenCalled());
  });

  it('shows the link with a single regenerate control once a link exists', () => {
    renderCard({ client_share_token: 'a'.repeat(64) });

    expect(screen.getByDisplayValue(new RegExp(`/gallery/client-gallery/client-access\\?token=${'a'.repeat(64)}$`)))
      .toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'clientAccess.regenerateToken' })).toHaveLength(1);
  });

  it('offers no link control while client access is off', () => {
    renderCard({ client_access_enabled: false, client_share_token: undefined });

    expect(screen.queryByRole('button', { name: 'clientAccess.regenerateToken' })).toBeNull();
  });
});
