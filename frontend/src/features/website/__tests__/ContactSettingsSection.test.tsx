/**
 * The contact form's settings in the Design panel (issue 2618): the spam
 * check, saved right away.
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, fb?: unknown) => (typeof fb === 'string' ? fb : (fb as { defaultValue?: string })?.defaultValue ?? k) }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));
vi.mock('react-toastify', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../../../hooks/usePermission', () => ({ usePermission: vi.fn(() => true) }));
vi.mock('../../../services/website.service', () => ({
  websiteService: { getContactSettings: vi.fn(), saveContactSettings: vi.fn() },
}));

import { websiteService } from '../../../services/website.service';
import { ContactSettingsSection } from '../ContactSettingsSection';
import { useContactSettingsDraft } from '../contactSettingsDraft';

// The builder page holds the draft and saves it through its bar; this
// stands in for both.
const Host: React.FC<{ readOnly: boolean }> = ({ readOnly }) => {
  const settings = useContactSettingsDraft();
  return (
    <>
      <ContactSettingsSection settings={settings} readOnly={readOnly} />
      {settings.canChange && <button type="button" onClick={() => { void settings.save(); }}>Save contact form settings</button>}
    </>
  );
};

const SETTINGS = {
  contact: { recipients: [] as string[], defaultRecipient: 'support@studio.example', confirmation: false },
  captcha: { provider: 'none' as const, friendly: { siteKey: '', endpoint: 'global' as const, apiKeySet: false }, recaptchaReady: false },
};

function open(readOnly = false) {
  render(<QueryClientProvider client={new QueryClient()}><MemoryRouter><Host readOnly={readOnly} /></MemoryRouter></QueryClientProvider>);
}

describe('contact form settings', () => {
  it('turns on Friendly Captcha with its keys; the API key is sent only when typed', async () => {
    vi.mocked(websiteService.getContactSettings).mockResolvedValue(SETTINGS);
    vi.mocked(websiteService.saveContactSettings).mockResolvedValue(SETTINGS);
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Friendly Captcha' }));
    fireEvent.change(screen.getByLabelText('Site key'), { target: { value: 'FCMTEST0123' } });
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'A1-secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Servers in the EU' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save contact form settings' }));
    await waitFor(() => expect(websiteService.saveContactSettings).toHaveBeenCalledWith(expect.objectContaining({
      captcha: { provider: 'friendly', friendly: { siteKey: 'FCMTEST0123', endpoint: 'eu', apiKey: 'A1-secret' } },
    })));
  });

  it('keeps a saved API key it does not show', async () => {
    vi.mocked(websiteService.getContactSettings).mockResolvedValue({ ...SETTINGS, captcha: { ...SETTINGS.captcha, provider: 'friendly', friendly: { siteKey: 'FCMTEST0123', endpoint: 'global', apiKeySet: true } } });
    open();
    expect(await screen.findByPlaceholderText('Saved. Type a new one to replace it.')).toHaveValue('');
    fireEvent.click(screen.getByRole('button', { name: 'Save contact form settings' }));
    await waitFor(() => expect(vi.mocked(websiteService.saveContactSettings).mock.calls.at(-1)?.[0].captcha.friendly).not.toHaveProperty('apiKey'));
  });

  it('reCAPTCHA points to the security settings while its keys are missing', async () => {
    vi.mocked(websiteService.getContactSettings).mockResolvedValue(SETTINGS);
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Google reCAPTCHA' }));
    expect(screen.getByRole('link', { name: /Settings › Security/ })).toHaveAttribute('href', '/admin/settings?tab=security');
  });

  it('sends new messages to the addresses entered, else to the support address it names', async () => {
    vi.mocked(websiteService.getContactSettings).mockResolvedValue(SETTINGS);
    vi.mocked(websiteService.saveContactSettings).mockResolvedValue(SETTINGS);
    open();
    const field = await screen.findByLabelText('Send new messages to');
    expect(field).toHaveAttribute('placeholder', 'support@studio.example');
    fireEvent.change(field, { target: { value: 'owner@studio.example, assistant@studio.example' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save contact form settings' }));
    await waitFor(() => expect(vi.mocked(websiteService.saveContactSettings).mock.calls.at(-1)?.[0].contact)
      .toEqual({ recipients: ['owner@studio.example', 'assistant@studio.example'], confirmation: false }));
    expect(screen.getByRole('link', { name: 'Edit the notification mail' })).toHaveAttribute('href', '/admin/settings?tab=email&template=website_contact_admin');
  });

  it('offers the confirmation to the visitor only with a spam check', async () => {
    vi.mocked(websiteService.getContactSettings).mockResolvedValue(SETTINGS);
    open();
    const toggle = await screen.findByRole('switch', { name: /confirmation/ });
    expect(toggle).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Friendly Captcha' }));
    expect(screen.getByRole('switch', { name: /confirmation/ })).not.toBeDisabled();
    expect(screen.getByRole('link', { name: 'Edit the confirmation mail' })).toHaveAttribute('href', '/admin/settings?tab=email&template=website_contact_confirmation');
  });

  it('is read-only without the settings permission', async () => {
    const { usePermission } = await import('../../../hooks/usePermission');
    vi.mocked(usePermission).mockReturnValue(false);
    vi.mocked(websiteService.getContactSettings).mockResolvedValue(SETTINGS);
    open();
    expect(await screen.findByLabelText('Send new messages to')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save contact form settings' })).toBeNull();
    vi.mocked(usePermission).mockReturnValue(true);
  });

  it('warns that a saved API key can no longer be read and has to be entered again', async () => {
    vi.mocked(websiteService.getContactSettings).mockResolvedValue({ ...SETTINGS, captcha: { ...SETTINGS.captcha, provider: 'friendly', friendly: { siteKey: 'FCMTEST0123', endpoint: 'global', apiKeySet: true, apiKeyUnreadable: true } } });
    open();
    expect(await screen.findByText(/can no longer be read/)).toBeInTheDocument();
    expect(screen.getByText(/refuses messages until/)).toBeInTheDocument();
  });
});
