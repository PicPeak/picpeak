/**
 * Issue 2209: a guest returns through their emailed invite link, which is
 * single use and already spent, on a device that no longer holds who they
 * are. The server answers 409 with the invite's guest and whether that guest
 * can recover by email. The visitor must be offered the email code then,
 * instead of browsing on unidentified and reading their empty favourites as
 * lost.
 */
import { act, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const redeemInvite = vi.fn();
vi.mock('../../services/guests.service', () => ({
  guestsService: { redeemInvite: (...args: unknown[]) => redeemInvite(...args) },
}));
const stored = vi.hoisted(() => ({ identity: null as { id: number; name: string } | null }));
vi.mock('../../utils/guestIdentityStorage', async () => {
  const actual = await vi.importActual<typeof import('../../utils/guestIdentityStorage')>('../../utils/guestIdentityStorage');
  return {
    ...actual,
    getGuestIdentity: () => stored.identity,
    storeGuestIdentity: vi.fn(),
    clearGuestIdentity: vi.fn(() => { stored.identity = null; }),
  };
});

import { GuestIdentityProvider, useGuestIdentity } from '../GuestIdentityContext';

let identityApi: ReturnType<typeof useGuestIdentity> | null = null;
const Probe: React.FC = () => { identityApi = useGuestIdentity(); return null; };

const mount = () => render(
  <QueryClientProvider client={new QueryClient()}>
    <GuestIdentityProvider slug="wedding" identityMode="guest"><Probe /></GuestIdentityProvider>
  </QueryClientProvider>,
);

const refuse = (status: number, data: Record<string, unknown>) => {
  redeemInvite.mockRejectedValueOnce(Object.assign(new Error('refused'), { response: { status, data } }));
};

describe('GuestIdentityProvider: spent invite on a device without the identity', () => {
  beforeEach(() => {
    redeemInvite.mockReset();
    stored.identity = null;
    identityApi = null;
    sessionStorage.clear();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(console.warn).mockClear();
    window.history.replaceState({}, '', '/gallery/wedding?invite=spent-token');
  });

  it('opens recovery when the guest can get a code', async () => {
    refuse(409, { error: 'already_redeemed', guest_id: 5, recoverable: true });
    mount();
    await waitFor(() => expect(identityApi?.recoveryOpen).toBe(true));
    expect(identityApi?.recoveryReason).toBe('spent-invite');
    expect(identityApi?.identity).toBeNull();
  });

  it('opens recovery when the device holds someone else, after dropping them', async () => {
    stored.identity = { id: 9, name: 'Previous visitor' };
    refuse(409, { error: 'already_redeemed', guest_id: 5, recoverable: true });
    mount();
    await waitFor(() => expect(identityApi?.recoveryOpen).toBe(true));
    expect(identityApi?.identity).toBeNull();
  });

  it('stays closed when the device already holds this guest', async () => {
    stored.identity = { id: 5, name: 'Invited' };
    refuse(409, { error: 'already_redeemed', guest_id: 5, recoverable: true });
    mount();
    await waitFor(() => expect(console.warn).toHaveBeenCalled());
    expect(identityApi?.recoveryOpen).toBe(false);
    expect(identityApi?.identity).toEqual({ id: 5, name: 'Invited' });
  });

  it('stays closed when no code could arrive, or the invite was revoked', async () => {
    refuse(409, { error: 'already_redeemed', guest_id: 5, recoverable: false });
    const first = mount();
    await waitFor(() => expect(console.warn).toHaveBeenCalledTimes(1));
    expect(identityApi?.recoveryOpen).toBe(false);
    first.unmount();

    window.history.replaceState({}, '', '/gallery/wedding?invite=revoked-token');
    refuse(410, { error: 'revoked', guest_id: 5 });
    mount();
    await waitFor(() => expect(console.warn).toHaveBeenCalledTimes(2));
    expect(identityApi?.recoveryOpen).toBe(false);
  });

  it('forgets the reason once recovery is closed, so opening it by hand shows the plain text', async () => {
    refuse(409, { error: 'already_redeemed', guest_id: 5, recoverable: true });
    mount();
    await waitFor(() => expect(identityApi?.recoveryReason).toBe('spent-invite'));
    act(() => identityApi!.closeRecovery());
    await waitFor(() => expect(identityApi?.recoveryOpen).toBe(false));
    act(() => identityApi!.openRecovery());
    await waitFor(() => expect(identityApi?.recoveryOpen).toBe(true));
    expect(identityApi?.recoveryReason).toBeNull();
  });
});
