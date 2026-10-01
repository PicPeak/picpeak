/**
 * Language moved out of the admin header.
 *
 * Two languages now sit in Settings → General and they have different scopes:
 * the admin's own UI language is a per-admin browser preference that applies
 * immediately, and the gallery/guest default is an instance setting saved with
 * the rest of the tab. Wiring the first one into the form state would put a
 * personal preference behind an instance-wide Save button — and let Discard
 * change the language out from under the admin mid-edit.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import i18n from 'i18next';
import { readFileSync } from 'fs';
import { resolve } from 'path';

import { GeneralTab } from '../tabs/GeneralTab';
import type { GeneralSettings } from '../hooks/useSettingsState';

vi.mock('../components/MfaSettingsCard', () => ({ MfaSettingsCard: () => null }));

const base: GeneralSettings = {
  site_url: 'https://example.com',
  site_url_env_pinned: false,
  site_url_stored: 'https://example.com',
  default_expiration_days: 30,
  max_file_size_mb: 50,
  max_video_size_mb: 500,
  video_web_rendition: false,
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

function renderTab() {
  const setGeneralSettings = vi.fn();
  render(
    <GeneralTab
      generalSettings={base}
      setGeneralSettings={setGeneralSettings as never}
      saveGeneralMutation={{ mutate: vi.fn(), isPending: false }}
      isDirty={false}
      onDiscard={() => {}}
      accountDirty={false}
      onDiscardAccount={() => {}}
      accountForm={{ username: 'a', email: 'a@b.c' }}
      accountErrors={{}}
      handleAccountChange={() => () => {}}
      handleAccountSubmit={() => {}}
      updateAdminProfileMutation={{ isPending: false }}
      adminProfileLoading={false}
    />,
  );
  return { setGeneralSettings };
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('GeneralTab — the two language scopes', () => {
  it('applies the admin language immediately and keeps it out of the save payload', () => {
    const changeLanguage = vi.spyOn(i18n, 'changeLanguage').mockResolvedValue(undefined as never);
    const { setGeneralSettings } = renderTab();

    const adminSelect = screen.getByLabelText(/your admin language/i);
    fireEvent.change(adminSelect, { target: { value: 'de' } });

    expect(changeLanguage).toHaveBeenCalledWith('de');
    // The instance settings must be untouched — this is a personal preference.
    expect(setGeneralSettings).not.toHaveBeenCalled();
  });

  it('keeps the gallery/guest default on the saved form state', () => {
    const changeLanguage = vi.spyOn(i18n, 'changeLanguage').mockResolvedValue(undefined as never);
    const { setGeneralSettings } = renderTab();

    fireEvent.change(screen.getByLabelText(/gallery & guest language/i), {
      target: { value: 'de' },
    });

    expect(setGeneralSettings).toHaveBeenCalled();
    expect(changeLanguage).not.toHaveBeenCalled();
  });

  it('puts the admin language first — it is the one the reader is using', () => {
    renderTab();
    const admin = screen.getByLabelText(/your admin language/i);
    const gallery = screen.getByLabelText(/gallery & guest language/i);
    // DOCUMENT_POSITION_FOLLOWING: `gallery` comes after `admin`.
    expect(admin.compareDocumentPosition(gallery) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('the header gave the language up', () => {
  const header = readFileSync(
    resolve(__dirname, '../../../components/admin/AdminHeader.tsx'), 'utf8',
  );

  it('no longer renders the standalone language selector', () => {
    expect(header).not.toMatch(/<LanguageSelector\s*\/>/);
  });

  it('shows the language list in the user menu at every width', () => {
    // It used to be phone-only. An admin who lands on a language they cannot
    // read must not have to navigate Settings in that language to escape it,
    // so this block must not be re-hidden behind `sm:hidden`.
    const block = header.slice(header.indexOf("t('common.language'") - 1200);
    expect(block).toMatch(/<div className="border-b border-line">/);
  });
});
