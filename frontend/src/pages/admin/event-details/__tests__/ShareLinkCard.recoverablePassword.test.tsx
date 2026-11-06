/**
 * "Show password" on the event page (#1271) exists only while the admin has
 * opted into recoverable storage in Settings → Security, and only for
 * galleries that have a secret to show.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { ShareLinkCard } from '../ShareLinkCard';
import type { Event } from '../../../../types';

const whatsApp = vi.hoisted(() => ({ configured: false }));
vi.mock('../../../../hooks/useWhatsAppConfigured', () => ({ useWhatsAppConfigured: () => whatsApp.configured }));
vi.mock('../../../../hooks/usePermission', () => ({ usePermission: () => true, useAnyPermission: () => true }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
  // components/common barrel -> ErrorBoundary -> i18n/config calls
  // .use(initReactI18next) at import time; same shim as ProductUsageTab.test.tsx
  initReactI18next: { type: '3rdParty', init: () => {} },
}));
vi.mock('react-toastify', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../../../../services/events.service', () => ({
  eventsService: {
    getQrBlob: vi.fn().mockRejectedValue(new Error('no qr in tests')),
    getGalleryPassword: vi.fn(),
    getGalleryPasswordStatus: vi.fn(),
    resendCreationEmail: vi.fn(),
  },
}));

import { eventsService } from '../../../../services/events.service';

const baseEvent = {
  id: 7,
  slug: 'ada-wedding',
  event_name: 'Ada Wedding',
  share_link: '/gallery/ada-wedding/tok',
  require_password: true,
  client_access_enabled: false,
  is_archived: false,
} as unknown as Event;

function renderCard(event: Partial<Event> = {}, passwordVersion = 0) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = (version: number) => (
    <QueryClientProvider client={client}>
      <ShareLinkCard event={{ ...baseEvent, ...event } as Event} setShowPasswordReset={() => {}} passwordVersion={version} />
    </QueryClientProvider>
  );
  const utils = render(tree(passwordVersion));
  return { ...utils, bump: (version: number) => utils.rerender(tree(version)) };
}

describe('ShareLinkCard — recoverable gallery password', () => {
  beforeEach(() => {
    vi.mocked(eventsService.getGalleryPasswordStatus).mockReset();
    vi.mocked(eventsService.getGalleryPassword).mockReset();
  });

  it('shows no password button while the setting is off', async () => {
    vi.mocked(eventsService.getGalleryPasswordStatus).mockResolvedValue({ enabled: false });
    renderCard();
    await waitFor(() => expect(eventsService.getGalleryPasswordStatus).toHaveBeenCalledWith(7));
    expect(screen.queryByTestId('show-gallery-password')).toBeNull();
    expect(screen.getByText('events.resetGalleryPassword')).toBeInTheDocument();
  });

  it('shows no password button for a public gallery without client access', async () => {
    vi.mocked(eventsService.getGalleryPasswordStatus).mockResolvedValue({ enabled: true });
    renderCard({ require_password: false, client_access_enabled: false });
    await waitFor(() => expect(eventsService.getGalleryPasswordStatus).toHaveBeenCalled());
    expect(screen.queryByTestId('show-gallery-password')).toBeNull();
  });

  it('reveals the stored password and client PIN on click, hides them again', async () => {
    vi.mocked(eventsService.getGalleryPasswordStatus).mockResolvedValue({ enabled: true });
    vi.mocked(eventsService.getGalleryPassword).mockResolvedValue({ enabled: true, password: 'Sunset-42!', client_password: '7788' });
    renderCard({ client_access_enabled: true });
    const button = await screen.findByTestId('show-gallery-password');
    expect(screen.queryByText('Sunset-42!')).toBeNull();
    fireEvent.click(button);
    expect(await screen.findByText('Sunset-42!')).toBeInTheDocument();
    expect(screen.getByText('7788')).toBeInTheDocument();
    expect(eventsService.getGalleryPassword).toHaveBeenCalledWith(7);
    fireEvent.click(screen.getByTestId('show-gallery-password'));
    expect(screen.queryByText('Sunset-42!')).toBeNull();
  });

  it('explains when nothing is stored yet', async () => {
    vi.mocked(eventsService.getGalleryPasswordStatus).mockResolvedValue({ enabled: true });
    vi.mocked(eventsService.getGalleryPassword).mockResolvedValue({ enabled: true, password: null, client_password: null });
    renderCard();
    fireEvent.click(await screen.findByTestId('show-gallery-password'));
    expect(await screen.findByText('events.galleryPasswordNotStored')).toBeInTheDocument();
  });

  it('drops a revealed password when the page reports a password change', async () => {
    vi.mocked(eventsService.getGalleryPasswordStatus).mockResolvedValue({ enabled: true });
    vi.mocked(eventsService.getGalleryPassword).mockResolvedValue({ enabled: true, password: 'Sunset-42!', client_password: null });
    const { bump } = renderCard({}, 0);
    fireEvent.click(await screen.findByTestId('show-gallery-password'));
    expect(await screen.findByText('Sunset-42!')).toBeInTheDocument();
    bump(1);
    await waitFor(() => expect(screen.queryByText('Sunset-42!')).toBeNull());
  });
});
