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
import { storeGuestIdentity } from '../../utils/guestIdentityStorage';

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

    // The invite leaves the address bar before the request is answered, so
    // the entry the lightbox pushes next is built from a clean URL.
    expect(window.location.search).toBe('');
    const photoUrl = new URL(window.location.href);
    photoUrl.searchParams.set('photo', '42');
    window.history.pushState({ photo: '42', photoPushed: true }, '', photoUrl.pathname + photoUrl.search);

    resolveRedeem({ guest: { id: 1, name: 'A' }, token: 't' });
    await waitFor(() => expect(storeGuestIdentity).toHaveBeenCalled());

    expect(window.location.search).toBe('?photo=42');
    expect(window.history.state).toEqual({ photo: '42', photoPushed: true });

    // Closing the photo goes Back to the grid entry, which must not carry the
    // spent token either (a reload there would try to redeem it again).
    await new Promise<void>((resolve) => {
      window.addEventListener('popstate', () => resolve(), { once: true });
      window.history.back();
    });
    expect(window.location.search).toBe('');
    expect(window.history.state).toEqual({});
  });
});
