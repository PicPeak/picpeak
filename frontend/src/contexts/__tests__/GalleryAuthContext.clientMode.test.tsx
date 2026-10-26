import React from 'react';
import { expect, it, vi, beforeEach } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GalleryAuthProvider, useGalleryAuth } from '../GalleryAuthContext';
import { getGalleryToken } from '../../utils/galleryAuthStorage';
import { getGuestIdentity, storeGuestIdentity } from '../../utils/guestIdentityStorage';
import { api } from '../../config/api';

const mocks = vi.hoisted(() => ({ enter: vi.fn(), leave: vi.fn() }));
const SLUG = 'pin-gallery';
vi.mock('../../config/api', () => ({ api: { get: vi.fn(async (_url: string, options: { params: { slug: string } }) => ({
  data: { valid: true, type: 'gallery', eventSlug: options.params.slug, accessLevel: 'guest' },
})) } }));
vi.mock('../../services', () => ({
  authService: { enterClientMode: mocks.enter, leaveClientMode: mocks.leave },
  galleryService: { getGalleryPhotos: vi.fn(async (slug: string) => ({ event: { id: slug === 'pin-gallery' ? 9 : 10, event_name: 'PIN gallery' } })) },
}));
vi.mock('../../utils/cleanupGalleryAuth', () => ({ cleanupOldGalleryAuth: vi.fn() }));
let auth: ReturnType<typeof useGalleryAuth>;
let navigate: ReturnType<typeof useNavigate>;
function Probe() { auth = useGalleryAuth(); navigate = useNavigate(); return null; }

async function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[`/gallery/${SLUG}`]}>
    <GalleryAuthProvider><Probe /></GalleryAuthProvider>
  </MemoryRouter></QueryClientProvider>);
  await waitFor(() => expect(auth.isAuthenticated).toBe(true));
  return client;
}

beforeEach(() => {
  vi.clearAllMocks(); sessionStorage.clear(); localStorage.clear();
  mocks.enter.mockResolvedValue({ token: 'new-client-token', accessLevel: 'client', viaClientPin: true, viaCustomer: false, event: { id: 9, event_name: 'PIN gallery' } });
  mocks.leave.mockResolvedValue({ token: 'new-guest-token', accessLevel: 'guest', viaCustomer: false, event: { id: 9, event_name: 'PIN gallery' } });
});

it.each([
  ['client', true, true],
  ['client', false, false],
  ['guest', true, false],
])('restores %s PIN provenance (%s) only from the server session', async (accessLevel, viaClientPin, expected) => {
  sessionStorage.setItem(`gallery_access_level_${SLUG}`, 'client');
  vi.mocked(api.get).mockResolvedValueOnce({ data: { valid: true, type: 'gallery', eventSlug: SLUG, accessLevel, viaClientPin } } as never);
  await mount();
  expect(auth.isClient).toBe(accessLevel === 'client');
  expect(auth.viaClientPin).toBe(expected);
});

it('replaces both local token and role, purges gallery caches, and keeps guest identity', async () => {
  const client = await mount();
  const encoded = (value: object) => btoa(JSON.stringify(value)).replace(/=+$/, '');
  const guestToken = `${encoded({ alg: 'none' })}.${encoded({ type: 'guest', exp: Math.floor(Date.now() / 1000) + 3600 })}.x`;
  storeGuestIdentity(SLUG, { id: 5, name: 'Invited' } as never, guestToken);
  client.setQueryData(['gallery-photos', SLUG, 'all', 'id', 'guest'], ['guest']);
  client.setQueryData(['gallery-people', SLUG, 'client'], ['private-person']);
  client.setQueryData(['gallery-photos', 'other-gallery'], ['other']);
  await act(async () => { await auth.enterClientMode(SLUG, 'pin'); });
  expect(auth.isClient).toBe(true);
  expect(auth.viaClientPin).toBe(true);
  expect(getGalleryToken(SLUG)).toBe('new-client-token');
  expect(client.getQueryData(['gallery-photos', SLUG, 'all', 'id', 'guest'])).toBeUndefined();
  expect(client.getQueryData(['gallery-people', SLUG, 'client'])).toBeUndefined();
  expect(client.getQueryData(['gallery-photos', 'other-gallery'])).toEqual(['other']);
  client.setQueryData(['gallery-photos', SLUG, 'all', 'id', 'client'], ['hidden-photo']);
  await act(async () => { await auth.leaveClientMode(SLUG); });
  expect(auth.isClient).toBe(false);
  expect(auth.viaClientPin).toBe(false);
  expect(getGalleryToken(SLUG)).toBe('new-guest-token');
  expect(sessionStorage.getItem(`gallery_access_level_${SLUG}`)).toBeNull();
  expect(client.getQueryData(['gallery-photos', SLUG, 'all', 'id', 'client'])).toBeUndefined();
  expect(getGuestIdentity(SLUG)).toEqual({ id: 5, name: 'Invited' });
});

it('cancels an in-flight client query so its late response cannot return after downgrade', async () => {
  const client = await mount();
  await act(async () => { await auth.enterClientMode(SLUG, 'pin'); });
  let finish!: (value: string[]) => void;
  const key = ['gallery-photos', SLUG, 'all', 'id', 'client'];
  const pending = client.fetchQuery({ queryKey: key, queryFn: () => new Promise<string[]>((resolve) => { finish = resolve; }) }).catch(() => undefined);
  await waitFor(() => expect(finish).toBeDefined());
  await act(async () => { await auth.leaveClientMode(SLUG); });
  finish(['hidden-photo']);
  await pending;
  expect(client.getQueryData(key)).toBeUndefined();
  expect(auth.isClient).toBe(false);
});

it('leaves guest auth and cached data untouched after an incorrect PIN', async () => {
  const client = await mount();
  client.setQueryData(['gallery-photos', SLUG], ['visible-photo']);
  mocks.enter.mockRejectedValue({ response: { status: 401 } });
  await act(async () => { await expect(auth.enterClientMode(SLUG, 'wrong')).rejects.toBeDefined(); });
  expect(auth.isClient).toBe(false);
  expect(auth.isAuthenticated).toBe(true);
  expect(auth.isSwitchingClientMode).toBe(false);
  expect(client.getQueryData(['gallery-photos', SLUG])).toEqual(['visible-photo']);
});

it('does not apply a late PIN response to a different gallery after navigation', async () => {
  await mount();
  let finish!: (response: unknown) => void;
  mocks.enter.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  let pending!: Promise<void>;
  act(() => { pending = auth.enterClientMode(SLUG, 'pin'); });
  await act(async () => { await navigate('/gallery/other-gallery'); });
  await waitFor(() => expect(auth.event?.id).toBe(10));
  await act(async () => {
    finish({ token: 'old-gallery-client', accessLevel: 'client', event: { id: 9, event_name: 'PIN gallery' } });
    await pending;
  });
  expect(auth.event?.id).toBe(10);
  expect(auth.isClient).toBe(false);
  expect(getGalleryToken(SLUG)).not.toBe('old-gallery-client');
});
