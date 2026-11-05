/**
 * "Send via WhatsApp": a wa.me link opened in the admin's own WhatsApp, with
 * the text built from the default template (saved setting, else the built-in
 * one). Nothing goes through the server except the template.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { WhatsAppInviteDialog } from '../WhatsAppInviteDialog';
import { settingsService } from '../../../../services/settings.service';
import type { Event } from '../../../../types';

const permissions = vi.hoisted(() => ({ granted: new Set<string>(['settings.view', 'settings.edit']) }));
vi.mock('../../../../hooks/usePermission', () => ({
  usePermission: (perm: string) => permissions.granted.has(perm),
  useAnyPermission: () => true,
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => (key === 'events.whatsappInvite.defaultTemplate' ? 'Hello {{name}}, "{{event}}": {{link}}' : key),
    i18n: { language: 'en' },
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));
vi.mock('react-toastify', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../../../../hooks/useLocalizedDate', () => ({ useLocalizedDate: () => ({ format: () => '1 June 2026' }) }));
vi.mock('../../../../services/settings.service', () => ({
  settingsService: { getSettings: vi.fn(), updateSettings: vi.fn() },
}));

const event = {
  id: 4,
  slug: 'anna-ben',
  event_name: 'Anna & Ben',
  event_date: '2026-06-01',
  customer_name: 'Anna',
  customer_phone: '+49 170 1234567',
} as unknown as Event;
const LINK = 'https://photos.test/gallery/anna-ben/tok';

function renderDialog(props: Partial<React.ComponentProps<typeof WhatsAppInviteDialog>> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onClose = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <WhatsAppInviteDialog open onClose={onClose} event={event} link={LINK} {...props} />
    </QueryClientProvider>,
  );
  return { onClose };
}

const message = () => screen.getByLabelText('events.whatsappInvite.messageLabel') as HTMLTextAreaElement;
const phone = () => screen.getByLabelText('events.whatsappInvite.phoneLabel') as HTMLInputElement;

describe('WhatsAppInviteDialog', () => {
  let open: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    permissions.granted = new Set(['settings.view', 'settings.edit']);
    vi.mocked(settingsService.getSettings).mockReset().mockResolvedValue({});
    vi.mocked(settingsService.updateSettings).mockReset().mockResolvedValue(undefined);
    open = vi.spyOn(window, 'open').mockImplementation(() => null);
  });
  afterEach(() => open.mockRestore());

  it('fills the built-in text and opens wa.me with the customer number', async () => {
    const { onClose } = renderDialog();
    await waitFor(() => expect(message().value).toBe(`Hello Anna, "Anna & Ben": ${LINK}`));
    expect(phone().value).toBe('+49 170 1234567');

    fireEvent.click(screen.getByText('events.whatsappInvite.open'));
    expect(open).toHaveBeenCalledWith(
      `https://wa.me/491701234567?text=${encodeURIComponent(`Hello Anna, "Anna & Ben": ${LINK}`)}`,
      '_blank',
      'noopener',
    );
    expect(onClose).toHaveBeenCalled();
  });

  it('uses the saved default text', async () => {
    vi.mocked(settingsService.getSettings).mockResolvedValue({ general_whatsapp_invite_template: 'Hi {{name}}, {{date}}: {{link}}' });
    renderDialog();
    await waitFor(() => expect(message().value).toBe(`Hi Anna, 1 June 2026: ${LINK}`));
  });

  it('does not read the setting without settings.view and offers no template editor without settings.edit', async () => {
    permissions.granted = new Set();
    renderDialog();
    await waitFor(() => expect(message().value).toBe(`Hello Anna, "Anna & Ben": ${LINK}`));
    expect(settingsService.getSettings).not.toHaveBeenCalled();
    expect(screen.queryByText('events.whatsappInvite.editTemplate')).toBeNull();
  });

  it('asks for the international format for a national number and still sends without it', async () => {
    renderDialog();
    await waitFor(() => expect(message().value).not.toBe(''));
    fireEvent.change(phone(), { target: { value: '0170 1234567' } });
    expect(screen.getByText('events.whatsappInvite.phoneNational')).toBeInTheDocument();

    fireEvent.click(screen.getByText('events.whatsappInvite.open'));
    expect(open.mock.calls[0][0]).toMatch(/^https:\/\/wa\.me\/\?text=/);
  });

  it('sends the edited text', async () => {
    renderDialog();
    await waitFor(() => expect(message().value).not.toBe(''));
    fireEvent.change(message(), { target: { value: 'Custom text' } });
    fireEvent.click(screen.getByText('events.whatsappInvite.open'));
    expect(open).toHaveBeenCalledWith('https://wa.me/491701234567?text=Custom%20text', '_blank', 'noopener');
  });

  it('saves a new default text and refills the message from it', async () => {
    renderDialog();
    await waitFor(() => expect(message().value).not.toBe(''));
    fireEvent.click(screen.getByText('events.whatsappInvite.editTemplate'));
    fireEvent.change(screen.getByLabelText('events.whatsappInvite.templateLabel'), { target: { value: '{{event}} → {{link}}' } });
    fireEvent.click(screen.getByText('events.whatsappInvite.saveTemplate'));

    await waitFor(() => expect(settingsService.updateSettings).toHaveBeenCalledWith({ general_whatsapp_invite_template: '{{event}} → {{link}}' }));
    await waitFor(() => expect(message().value).toBe(`Anna & Ben → ${LINK}`));
  });

  it('notes that the password goes separately only for a protected gallery', async () => {
    renderDialog({ passwordProtected: true });
    expect(await screen.findByText('events.whatsappInvite.passwordNote')).toBeInTheDocument();
  });

  it('has no password note for an open link', async () => {
    renderDialog();
    await waitFor(() => expect(message().value).not.toBe(''));
    expect(screen.queryByText('events.whatsappInvite.passwordNote')).toBeNull();
  });
});
