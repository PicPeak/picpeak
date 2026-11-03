/**
 * Favourite lists are the guest's own (issue 2303), and their owner sits above
 * this provider. A change of identity must drop the cached lists, not just mark
 * them stale, or the previous guest's lists stay on screen (and their ids stay
 * "valid") until the refetch lands.
 */
import { act, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../services/guests.service', () => ({
  guestsService: {
    redeemInvite: vi.fn(),
    registerGuest: vi.fn(async () => ({ guest: { id: 7, name: 'Me' }, token: 'mine' })),
  },
}));
vi.mock('../../utils/guestIdentityStorage', async () => {
  const actual = await vi.importActual<typeof import('../../utils/guestIdentityStorage')>('../../utils/guestIdentityStorage');
  return { ...actual, getGuestIdentity: () => null, storeGuestIdentity: vi.fn() };
});

import { GuestIdentityProvider, useGuestIdentity } from '../GuestIdentityContext';

let identityApi: ReturnType<typeof useGuestIdentity> | null = null;
const Probe: React.FC = () => { identityApi = useGuestIdentity(); return null; };

describe('GuestIdentityProvider and the favourite lists', () => {
  it('drops the cached lists when the identity changes', async () => {
    window.history.replaceState({}, '', '/gallery/wedding');
    const client = new QueryClient();
    client.setQueryData(['favorite-lists', 'wedding'], { default_count: 0, lists: [{ id: 4, name: 'Print', count: 1 }] });
    client.setQueryData(['favorite-lists', 'other'], { default_count: 0, lists: [] });
    render(
      <QueryClientProvider client={client}>
        <GuestIdentityProvider slug="wedding" identityMode="guest"><Probe /></GuestIdentityProvider>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(identityApi).not.toBeNull());

    await act(() => identityApi!.register('Me'));

    expect(client.getQueryData(['favorite-lists', 'wedding'])).toBeUndefined();
    // Another gallery's lists are not this provider's business.
    expect(client.getQueryData(['favorite-lists', 'other'])).toBeDefined();
  });
});
