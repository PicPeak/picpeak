/**
 * The contact form settings' draft (issue 2618) keeps the same discipline as
 * the website's draft: it is compared with the settings it was taken from,
 * a refetch only fills in the fields the admin has not touched, a save
 * keeps what was typed while it ran, and a save from a stale view is
 * refused (409) with a way to load the latest.
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../../../hooks/usePermission', () => ({ usePermission: () => true }));
vi.mock('../../../services/website.service', () => ({
  websiteService: { getContactSettings: vi.fn(), saveContactSettings: vi.fn() },
}));

import { websiteService, type ContactSettings } from '../../../services/website.service';
import { CONTACT_SETTINGS_KEY, useContactSettingsDraft } from '../contactSettingsDraft';

const settings = (over: { recipients?: string[]; siteKey?: string; revision?: number } = {}): ContactSettings => ({
  revision: over.revision ?? 1,
  contact: { recipients: over.recipients ?? [], defaultRecipient: '', confirmation: false },
  captcha: { provider: 'none', friendly: { siteKey: over.siteKey ?? '', endpoint: 'global', apiKeySet: false }, recaptchaReady: false },
});

function setup(initial: ContactSettings) {
  vi.mocked(websiteService.getContactSettings).mockResolvedValue(initial);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const hook = renderHook(() => useContactSettingsDraft(), { wrapper });
  return { client, hook };
}

describe('contact settings draft', () => {
  it('a refetch fills in only the fields the admin has not edited, and dirty compares with what was taken', async () => {
    const { client, hook } = setup(settings());
    await waitFor(() => expect(hook.result.current.draft).not.toBeNull());
    act(() => hook.result.current.set({ recipients: 'me@studio.example' }));
    expect(hook.result.current.dirty).toBe(true);
    // A colleague changed both fields meanwhile.
    act(() => { client.setQueryData(CONTACT_SETTINGS_KEY, settings({ recipients: ['colleague@studio.example'], siteKey: 'FCMNEW0001', revision: 2 })); });
    await waitFor(() => expect(hook.result.current.draft?.siteKey).toBe('FCMNEW0001'));
    expect(hook.result.current.draft?.recipients).toBe('me@studio.example');
    expect(hook.result.current.dirty).toBe(true);
    // Typing the server's value back is clean again.
    act(() => hook.result.current.set({ recipients: 'colleague@studio.example' }));
    expect(hook.result.current.dirty).toBe(false);
  });

  it('a save keeps what was typed while it ran, and sends the revision it was made from', async () => {
    const { hook } = setup(settings({ revision: 4 }));
    await waitFor(() => expect(hook.result.current.draft).not.toBeNull());
    act(() => hook.result.current.set({ recipients: 'a@studio.example' }));
    let resolve: (v: ContactSettings) => void = () => {};
    vi.mocked(websiteService.saveContactSettings).mockReturnValue(new Promise((r) => { resolve = r; }));
    let saving: Promise<unknown> = Promise.resolve();
    act(() => { saving = hook.result.current.save(); });
    await waitFor(() => expect(websiteService.saveContactSettings).toHaveBeenCalled());
    expect(vi.mocked(websiteService.saveContactSettings).mock.calls[0][0].revision).toBe(4);
    // Typed while the request runs.
    act(() => hook.result.current.set({ siteKey: 'FCMTYPED01' }));
    await act(async () => { resolve(settings({ recipients: ['a@studio.example'], revision: 5 })); await saving; });
    expect(hook.result.current.draft).toMatchObject({ recipients: 'a@studio.example', siteKey: 'FCMTYPED01' });
    expect(hook.result.current.dirty).toBe(true);
  });

  it('a save from a stale view says so, and loading the latest drops the stale edits', async () => {
    const { hook } = setup(settings({ revision: 1 }));
    await waitFor(() => expect(hook.result.current.draft).not.toBeNull());
    act(() => hook.result.current.set({ recipients: 'stale@studio.example' }));
    vi.mocked(websiteService.saveContactSettings).mockRejectedValue({ response: { status: 409, data: { code: 'WEBSITE_CONTACT_CONFLICT' } } });
    await act(async () => { await hook.result.current.save().catch(() => {}); });
    expect(hook.result.current.conflict).toBe(true);
    vi.mocked(websiteService.getContactSettings).mockResolvedValue(settings({ recipients: ['colleague@studio.example'], revision: 2 }));
    await act(async () => { await hook.result.current.loadLatest(); });
    expect(hook.result.current.conflict).toBe(false);
    expect(hook.result.current.draft?.recipients).toBe('colleague@studio.example');
    expect(hook.result.current.dirty).toBe(false);
  });

  it('a read that started before a save and answers after it is not taken in', async () => {
    const { client, hook } = setup(settings({ revision: 1 }));
    await waitFor(() => expect(hook.result.current.draft).not.toBeNull());
    act(() => hook.result.current.set({ recipients: 'new@studio.example' }));
    vi.mocked(websiteService.saveContactSettings).mockResolvedValue(settings({ recipients: ['new@studio.example'], revision: 2 }));
    await act(async () => { await hook.result.current.save(); });
    // The older read lands now.
    act(() => { client.setQueryData(CONTACT_SETTINGS_KEY, settings({ recipients: [], revision: 1 })); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(hook.result.current.draft?.recipients).toBe('new@studio.example');
    expect(hook.result.current.dirty).toBe(false);
  });
});
