/**
 * Redeeming an invite strips `?invite=` from the address bar. Redemption is
 * asynchronous, so a visitor can open a photo (`?photo=` + the lightbox's
 * history state) before it settles; the cleanup must leave both in place or
 * closing the photo has nothing to return to.
 */
import { render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

let resolveRedeem: (v: any) => void = () => {};
vi.mock('../../services/guests.service', () => ({
  guestsService: {
    redeemInvite: vi.fn(() => new Promise((resolve) => { resolveRedeem = resolve; })),
  },
}));
vi.mock('../../utils/guestIdentityStorage', async () => {
  const actual = await vi.importActual<typeof import('../../utils/guestIdentityStorage')>('../../utils/guestIdentityStorage');
  return { ...actual, getGuestIdentity: () => null, storeGuestIdentity: vi.fn() };
});

import { GuestIdentityProvider } from '../GuestIdentityContext';

describe('GuestIdentityProvider invite cleanup', () => {
  it('keeps a photo opened during redemption, in the URL and in the history state', async () => {
    window.history.replaceState({}, '', '/gallery/wedding?invite=tok123');
    const client = new QueryClient();
    render(
      <QueryClientProvider client={client}>
        <GuestIdentityProvider slug="wedding" identityMode="guest"><div /></GuestIdentityProvider>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(resolveRedeem).not.toBeUndefined());

    // The lightbox opens a photo while the redeem request is in flight.
    window.history.pushState({ photo: '42', photoPushed: true }, '', '/gallery/wedding?invite=tok123&photo=42');

    resolveRedeem({ guest: { id: 1, name: 'A' }, token: 't' });

    await waitFor(() => expect(window.location.search).not.toContain('invite='));
    expect(window.location.search).toBe('?photo=42');
    expect(window.history.state).toEqual({ photo: '42', photoPushed: true });
  });
});
