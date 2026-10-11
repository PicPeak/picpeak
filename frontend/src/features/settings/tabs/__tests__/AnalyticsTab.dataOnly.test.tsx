import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AnalyticsTab } from '../AnalyticsTab';
import type { AnalyticsSettings } from '../../hooks/useSettingsState';
vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({ t: (key: string, fallback?: string) => fallback || key }),
}));
afterEach(cleanup);
const base: AnalyticsSettings = {
  tracker_provider: 'custom', honor_do_not_track: true, custom_head_html: '<script>window.__evil = true</script>',
  umami_enabled: false, umami_url: '', umami_website_id: '', umami_share_url: '', umami_api_key: '',
  rybbit_url: '', rybbit_website_id: '', rybbit_api_key: '',
};
function show(provider: AnalyticsSettings['tracker_provider']) {
  return render(<AnalyticsTab analyticsSettings={{ ...base, tracker_provider: provider }}
    setAnalyticsSettings={vi.fn()} saveAnalyticsMutation={{ mutate: vi.fn(), isPending: false }}
    isDirty={false} onDiscard={vi.fn()} />);
}
it('shows an inert legacy notice, not an executable HTML editor or active custom option', () => {
  const view = show('custom');
  expect(screen.getByRole('status')).toHaveTextContent('legacy custom snippet is disabled');
  expect(screen.getByRole('option', { name: 'Custom scripts disabled' })).toBeDisabled();
  expect(view.container.querySelector('textarea, script, iframe')).toBeNull();
  expect(view.container.innerHTML).not.toContain('window.__evil');
});
it.each(['umami', 'rybbit'] as const)('offers data-only %s collection and HTTPS guidance', provider => {
  show(provider);
  expect(screen.getByText('Data-only analytics forwarding')).toBeInTheDocument();
  expect(screen.getByText(/Production collectors must use HTTPS/)).toBeInTheDocument();
  // Issue 1910: say that opted-out browsers are not counted.
  expect(screen.getByText(/Global Privacy Control .* are never counted/)).toBeInTheDocument();
  // Issue 1921: Do Not Track is the operator's choice, on by default.
  expect(screen.getByRole('checkbox', { name: /Honour Do Not Track/ })).toBeChecked();
  expect(screen.queryByRole('option', { name: 'custom' })).toBeNull();
});
it('switching Do Not Track honouring off changes only that setting', () => {
  const setAnalyticsSettings = vi.fn();
  render(<AnalyticsTab analyticsSettings={{ ...base, tracker_provider: 'rybbit' }}
    setAnalyticsSettings={setAnalyticsSettings} saveAnalyticsMutation={{ mutate: vi.fn(), isPending: false }}
    isDirty={false} onDiscard={vi.fn()} />);
  fireEvent.click(screen.getByRole('checkbox', { name: /Honour Do Not Track/ }));
  const update = setAnalyticsSettings.mock.calls[0][0] as (prev: AnalyticsSettings) => AnalyticsSettings;
  expect(update({ ...base, tracker_provider: 'rybbit' })).toEqual({ ...base, tracker_provider: 'rybbit', honor_do_not_track: false });
});
it('says next to the share URL that embedding also needs the dashboard origin in frame-src', () => {
  show('umami');
  expect(screen.getByText(/settings\.analytics\.shareUrlHelp/)).toHaveTextContent('analytics.embedCspHint');
});
