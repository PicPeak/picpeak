/**
 * The browser-playable video copies setting (issue 1430, item 8) is a
 * checkbox on the General tab, saved with the rest of it as
 * general_video_web_rendition.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

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
  allowed_file_types: 'jpg,png,mp4',
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

function renderTab(settings: GeneralSettings) {
  // Run the updater at once, the way React does inside the event: the
  // handler reads e.target.checked, which the controlled input resets to
  // the prop value as soon as the event is over.
  const applied: GeneralSettings[] = [];
  const setGeneralSettings = vi.fn((update: GeneralSettings | ((prev: GeneralSettings) => GeneralSettings)) => {
    applied.push(typeof update === 'function' ? update(settings) : update);
  });
  render(
    <GeneralTab
      generalSettings={settings}
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
  return { setGeneralSettings, applied };
}

afterEach(cleanup);

describe('GeneralTab video web rendition', () => {
  it('is off by default and flips the form state on', () => {
    const { setGeneralSettings, applied } = renderTab(base);
    const box = screen.getByTestId('general-video-web-rendition') as HTMLInputElement;
    expect(box.checked).toBe(false);

    fireEvent.click(box);

    expect(setGeneralSettings).toHaveBeenCalledTimes(1);
    expect(applied[0].video_web_rendition).toBe(true);
  });

  it('reflects a stored true', () => {
    renderTab({ ...base, video_web_rendition: true });
    expect((screen.getByTestId('general-video-web-rendition') as HTMLInputElement).checked).toBe(true);
  });
});
