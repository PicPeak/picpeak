/**
 * Issue 2630: an admin panel opened on an internal domain must still hand out
 * links on the configured public site URL. The share-link card (field, copy,
 * QR) and the client-access link read it from the public settings; without a
 * valid site URL they keep the browser origin.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { ShareLinkCard } from '../ShareLinkCard';
import { ClientAccessCard } from '../ClientAccessCard';
import type { Event } from '../../../../types';

const settings = vi.hoisted(() => ({ public_site_url: null as string | null }));
const service = vi.hoisted(() => ({
  getQrBlob: vi.fn(),
  getGalleryPassword: vi.fn(),
  getGalleryPasswordStatus: vi.fn(),
  resendCreationEmail: vi.fn(),
  updateEvent: vi.fn(),
}));
vi.mock('../../../../services/publicSettings.service', () => ({
  publicSettingsService: { getPublicSettings: vi.fn(async () => ({ public_site_url: settings.public_site_url })) },
}));
vi.mock('../../../../services/events.service', () => ({ eventsService: service }));
vi.mock('../../../../hooks/useWhatsAppConfigured', () => ({ useWhatsAppConfigured: () => false }));
vi.mock('../../../../hooks/usePermission', () => ({ usePermission: () => true, useAnyPermission: () => true }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));
vi.mock('react-toastify', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const ADMIN_ORIGIN = 'https://galerie.int.example.com';
const originalLocation = window.location;
const writeText = vi.fn();

const event = {
  id: 9,
  slug: 'wedding',
  event_name: 'Wedding',
  share_link: '/gallery/wedding/tok123',
  require_password: true,
  client_access_enabled: true,
  client_share_token: 'c'.repeat(16),
  is_archived: false,
} as unknown as Event;

function renderCards() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ShareLinkCard event={event} setShowPasswordReset={() => {}} passwordVersion={0} />
      <ClientAccessCard event={event} refetchEvent={vi.fn()} />
    </QueryClientProvider>,
  );
}

describe('admin links for guests use the public site URL', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    service.getQrBlob.mockRejectedValue(new Error('no qr in tests'));
    service.getGalleryPasswordStatus.mockResolvedValue({ enabled: false });
    Object.defineProperty(window, 'location', {
      value: { origin: ADMIN_ORIGIN, hostname: 'galerie.int.example.com', href: `${ADMIN_ORIGIN}/admin/events/9` },
      configurable: true,
    });
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    writeText.mockResolvedValue(undefined);
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', { value: originalLocation, configurable: true });
  });

  it('shows, copies and QR-encodes the share link on the site URL, not the admin origin', async () => {
    settings.public_site_url = 'https://galerie.example.com';
    renderCards();

    expect(await screen.findByDisplayValue('https://galerie.example.com/gallery/wedding/tok123')).toBeInTheDocument();
    expect(screen.getByDisplayValue(`https://galerie.example.com/gallery/wedding/client-access?token=${'c'.repeat(16)}`))
      .toBeInTheDocument();

    fireEvent.click(screen.getAllByText('events.copy')[0]);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('https://galerie.example.com/gallery/wedding/tok123'));

    await waitFor(() => expect(service.getQrBlob).toHaveBeenLastCalledWith(9, 'png', 300, 'https://galerie.example.com'));
  });

  it('keeps the browser origin when no site URL is configured', async () => {
    settings.public_site_url = null;
    renderCards();

    expect(await screen.findByDisplayValue(`${ADMIN_ORIGIN}/gallery/wedding/tok123`)).toBeInTheDocument();
    expect(screen.getByDisplayValue(`${ADMIN_ORIGIN}/gallery/wedding/client-access?token=${'c'.repeat(16)}`)).toBeInTheDocument();
    await waitFor(() => expect(service.getQrBlob).toHaveBeenCalledWith(9, 'png', 300, ADMIN_ORIGIN));
  });

  it('keeps the browser origin when the site URL is not a usable address', async () => {
    settings.public_site_url = 'galerie.example.com';
    renderCards();

    await waitFor(() => expect(service.getQrBlob).toHaveBeenCalled());
    expect(screen.getByDisplayValue(`${ADMIN_ORIGIN}/gallery/wedding/tok123`)).toBeInTheDocument();
    expect(screen.queryByDisplayValue(/galerie\.example\.com/)).toBeNull();
  });
});
