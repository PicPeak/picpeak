/**
 * Redeeming an invite strips `?invite=` from the address bar. Redemption is
 * asynchronous, so a visitor can open a photo (`?photo=` + the lightbox's
 * history state) before it settles; the cleanup must leave both in place or
 * closing the photo has nothing to return to.
 */
import { act, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let resolveRedeem: (v: any) => void = () => {};
let rejectRedeem: (e: any) => void = () => {};
const redeemInvite = vi.fn(() => new Promise((resolve, reject) => { resolveRedeem = resolve; rejectRedeem = reject; }));
const registerGuest = vi.fn(async () => ({ guest: { id: 7, name: 'Me' }, token: 'mine' }));
const verifyRecoveryCode = vi.fn(async () => ({ guest: { id: 8, name: 'Me again' }, token: 'mine-again' }));
vi.mock('../../services/guests.service', () => ({
  guestsService: {
    redeemInvite: (...args: unknown[]) => redeemInvite(...args),
    registerGuest: (...args: unknown[]) => registerGuest(...args),
    verifyRecoveryCode: (...args: unknown[]) => verifyRecoveryCode(...args),
  },
}));
vi.mock('../../utils/guestIdentityStorage', async () => {
  const actual = await vi.importActual<typeof import('../../utils/guestIdentityStorage')>('../../utils/guestIdentityStorage');
  return { ...actual, getGuestIdentity: () => null, storeGuestIdentity: vi.fn() };
});

import { GuestIdentityProvider, useGuestIdentity } from '../GuestIdentityContext';
import { storeGuestIdentity } from '../../utils/guestIdentityStorage';

// Exposes register / recoverVerify to the test through the context.
let identityApi: ReturnType<typeof useGuestIdentity> | null = null;
const Probe: React.FC = () => { identityApi = useGuestIdentity(); return null; };

const mount = (slug = 'wedding') => {
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <GuestIdentityProvider slug={slug} identityMode="guest"><Probe /></GuestIdentityProvider>
    </QueryClientProvider>,
  );
};

describe('GuestIdentityProvider invite cleanup', () => {
  beforeEach(() => {
    redeemInvite.mockClear();
    vi.mocked(storeGuestIdentity).mockClear();
    sessionStorage.clear();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('keeps the token pending after a retryable failure, so a reload redeems again', async () => {
    window.history.replaceState({ r: 1 }, '', '/gallery/wedding?invite=tok123&folder=7');
    const view = mount();
    await waitFor(() => expect(redeemInvite).toHaveBeenCalledTimes(1));
    // Out of the URL at once, into the session slot.
    expect(window.location.search).toBe('?folder=7');
    expect(window.history.state).toEqual({ r: 1 });
    expect(sessionStorage.getItem('picpeak:pending-invite:wedding')).toBe('tok123');

    rejectRedeem(Object.assign(new Error('Network Error'), { response: undefined }));
    await waitFor(() => expect(console.warn).toHaveBeenCalled());
    expect(sessionStorage.getItem('picpeak:pending-invite:wedding')).toBe('tok123');
    expect(window.location.search).toBe('?folder=7');

    // The "reload" — on a history entry without the token — still redeems it.
    view.unmount();
    window.history.replaceState({}, '', '/gallery/wedding');
    mount();
    await waitFor(() => expect(redeemInvite).toHaveBeenCalledTimes(2));
    expect(redeemInvite).toHaveBeenLastCalledWith('wedding', 'tok123');
    // 429 / 5xx are retryable as well.
    rejectRedeem(Object.assign(new Error('Too Many Requests'), { response: { status: 429 } }));
    await waitFor(() => expect(console.warn).toHaveBeenCalledTimes(2));
    expect(sessionStorage.getItem('picpeak:pending-invite:wedding')).toBe('tok123');
  });

  it('takes the invite out of the URL before the identity mode is known', async () => {
    // The provider mounts in `simple` mode until the feedback settings land;
    // a photo opened in that window must not copy the token into its entry.
    window.history.replaceState({}, '', '/gallery/wedding?invite=tok123');
    const client = new QueryClient();
    const tree = (mode: 'simple' | 'guest') => (
      <QueryClientProvider client={client}>
        <GuestIdentityProvider slug="wedding" identityMode={mode}><Probe /></GuestIdentityProvider>
      </QueryClientProvider>
    );
    const { rerender } = render(tree('simple'));
    expect(window.location.search).toBe('');
    expect(redeemInvite).not.toHaveBeenCalled();

    const photoUrl = new URL(window.location.href);
    photoUrl.searchParams.set('photo', '42');
    window.history.pushState({ photo: '42', photoPushed: true }, '', photoUrl.pathname + photoUrl.search);
    expect(window.location.search).toBe('?photo=42');

    // The settings arrive: guest mode redeems the parked token.
    rerender(tree('guest'));
    await waitFor(() => expect(redeemInvite).toHaveBeenCalledWith('wedding', 'tok123'));
    resolveRedeem({ guest: { id: 1, name: 'A' }, token: 't' });
    await waitFor(() => expect(storeGuestIdentity).toHaveBeenCalled());
    expect(window.location.search).toBe('?photo=42');

    await new Promise<void>((resolve) => {
      window.addEventListener('popstate', () => resolve(), { once: true });
      window.history.back();
    });
    expect(window.location.search).toBe('');
  });

  it('still redeems when sessionStorage refuses the token', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    try {
      window.history.replaceState({}, '', '/gallery/wedding?invite=tok123');
      mount();
      await waitFor(() => expect(redeemInvite).toHaveBeenCalledWith('wedding', 'tok123'));
      expect(window.location.search).toBe('');
      resolveRedeem({ guest: { id: 1, name: 'A' }, token: 't' });
      await waitFor(() => expect(storeGuestIdentity).toHaveBeenCalled());
    } finally {
      setItem.mockRestore();
    }
  });

  it('drops the pending token when the visitor registers or recovers instead', async () => {
    for (const flow of ['register', 'recover'] as const) {
      sessionStorage.clear();
      window.history.replaceState({}, '', '/gallery/wedding?invite=stuck');
      const view = mount();
      await waitFor(() => expect(redeemInvite).toHaveBeenCalled());
      rejectRedeem(Object.assign(new Error('Network Error'), { response: undefined }));
      await waitFor(() => expect(sessionStorage.getItem('picpeak:pending-invite:wedding')).toBe('stuck'));

      if (flow === 'register') await act(() => identityApi!.register('Me', 'me@example.com'));
      else await act(() => identityApi!.recoverVerify('me@example.com', '123456'));

      // A reload must not retry the stale invite over the identity just made.
      expect(sessionStorage.getItem('picpeak:pending-invite:wedding')).toBeNull();
      view.unmount();
    }
  });

  it('drops the pending token after a terminal answer and after success', async () => {
    window.history.replaceState({}, '', '/gallery/wedding?invite=spent');
    const view = mount();
    await waitFor(() => expect(redeemInvite).toHaveBeenCalledTimes(1));
    rejectRedeem(Object.assign(new Error('Gone'), { response: { status: 410, data: {} } }));
    await waitFor(() => expect(console.warn).toHaveBeenCalled());
    expect(window.location.search).toBe('');
    expect(sessionStorage.getItem('picpeak:pending-invite:wedding')).toBeNull();
    view.unmount();

    window.history.replaceState({}, '', '/gallery/wedding?invite=fresh');
    mount();
    await waitFor(() => expect(redeemInvite).toHaveBeenCalledTimes(2));
    resolveRedeem({ guest: { id: 1, name: 'A' }, token: 't' });
    await waitFor(() => expect(storeGuestIdentity).toHaveBeenCalled());
    expect(sessionStorage.getItem('picpeak:pending-invite:wedding')).toBeNull();
  });

  it('keeps a photo opened during redemption, in the URL and in the history state', async () => {
    window.history.replaceState({}, '', '/gallery/wedding?invite=tok123');
    mount();
    await waitFor(() => expect(redeemInvite).toHaveBeenCalledTimes(1));

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
