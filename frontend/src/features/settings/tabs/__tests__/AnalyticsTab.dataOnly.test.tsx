import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AnalyticsTab } from '../AnalyticsTab';
import type { AnalyticsSettings } from '../../hooks/useSettingsState';
vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({ t: (key: string, fallback?: string) => fallback || key }),
}));
afterEach(cleanup);
const base: AnalyticsSettings = {
  tracker_provider: 'custom', custom_head_html: '<script>window.__evil = true</script>',
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
  expect(screen.queryByRole('option', { name: 'custom' })).toBeNull();
});
it('says next to the share URL that embedding also needs the dashboard origin in frame-src', () => {
  show('umami');
  expect(screen.getByText(/settings\.analytics\.shareUrlHelp/)).toHaveTextContent('analytics.embedCspHint');
});
