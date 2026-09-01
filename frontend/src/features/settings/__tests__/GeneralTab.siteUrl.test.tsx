/**
 * Site URL validation must not strand an admin on load (#1104).
 *
 * `general_site_url` was free-text until this change added a server-side
 * check, so an upgraded install can hold a schemeless value nobody typed
 * today. Flagging that on load disables Save for every General setting — and
 * an admin holding `settings.edit` but not `settings.domains` cannot clear it
 * either, because correcting the address is a change to a protected key and
 * 403s. The tab has no permission gating, so they would simply be locked out.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { GeneralTab } from '../tabs/GeneralTab';
import type { GeneralSettings } from '../hooks/useSettingsState';

vi.mock('../components/MfaSettingsCard', () => ({ MfaSettingsCard: () => null }));

const base: GeneralSettings = {
  site_url: '',
  site_url_env_pinned: false,
  site_url_stored: '',
  default_expiration_days: 30,
  max_file_size_mb: 50,
  max_video_size_mb: 500,
  max_files_per_upload: 500,
  allowed_file_types: 'jpg,png',
  max_upload_batch_size_mb: 95,
  enable_analytics: true,
  enable_registration: false,
  maintenance_mode: false,
  short_gallery_urls: false,
  use_original_filenames_for_downloads: false,
  default_language: 'en',
  date_format: { format: 'dd/MM/yyyy', locale: 'en-GB' },
  time_format: '24h',
};

function renderTab(overrides: Partial<GeneralSettings>) {
  let settings = { ...base, ...overrides };
  const setGeneralSettings = vi.fn((updater) => {
    settings = typeof updater === 'function' ? updater(settings) : updater;
    rerender(<Tab />);
  });
  const Tab = () => (
    <GeneralTab
      generalSettings={settings}
      setGeneralSettings={setGeneralSettings as never}
      saveGeneralMutation={{ mutate: vi.fn(), isPending: false }}
      accountForm={{ username: 'a', email: 'a@b.c' }}
      accountErrors={{}}
      handleAccountChange={() => () => {}}
      handleAccountSubmit={() => {}}
      updateAdminProfileMutation={{ isPending: false }}
      adminProfileLoading={false}
    />
  );
  const { rerender } = render(<Tab />);
  return {
    saveButton: () => screen.getByRole('button', { name: /save general settings|allgemeine/i }),
    urlInput: () => screen.getByPlaceholderText('https://yourdomain.com'),
  };
}

describe('GeneralTab — Site URL validation', () => {
  it('does not block Save on a stored value the admin never touched', () => {
    // The upgrade case: schemeless value already in the database.
    const { saveButton } = renderTab({
      site_url: 'gallery.example.com',
      site_url_stored: 'gallery.example.com',
    });
    expect(saveButton()).not.toBeDisabled();
  });

  it('blocks Save once the admin edits it to something unusable', () => {
    const { saveButton, urlInput } = renderTab({
      site_url: 'https://gallery.example.com',
      site_url_stored: 'https://gallery.example.com',
    });
    expect(saveButton()).not.toBeDisabled();

    fireEvent.change(urlInput(), { target: { value: 'gallery.example.com' } });
    expect(saveButton()).toBeDisabled();
  });

  it('allows Save when the edit is a usable absolute url', () => {
    const { saveButton, urlInput } = renderTab({
      site_url: '',
      site_url_stored: '',
    });
    // Bare hosts and IPs are fine — LAN and NAS installs run on those.
    fireEvent.change(urlInput(), { target: { value: 'http://nas:3000' } });
    expect(saveButton()).not.toBeDisabled();
  });

  it('stays quiet while the environment pins the value', () => {
    // Pinned seeds the field with the EFFECTIVE env value, which differs from
    // the stored setting — that difference must not read as an edit.
    const { saveButton, urlInput } = renderTab({
      site_url: 'http://localhost:3000',
      site_url_stored: 'gallery.example.com',
      site_url_env_pinned: true,
    });
    expect(saveButton()).not.toBeDisabled();
    expect(urlInput()).toBeDisabled();
  });
});
