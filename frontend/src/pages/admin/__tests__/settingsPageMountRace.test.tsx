/**
 * Settings crashed on a fresh/hard load of any non-default tab (QA J.08).
 *
 * The nav groups are permission-filtered, so before PermissionsContext has
 * resolved every group filters to empty, `allItems[0]` is undefined, and the
 * section heading's `<activeItem.icon />` throws. In-app SPA navigation never
 * hit it because the context was already warm.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({ t: (k: string, fb?: unknown) => (typeof fb === 'string' ? fb : k) }),
  };
});

const flagsState = { flags: {} as Record<string, boolean>, isLoading: false };
vi.mock('../../../contexts/FeatureFlagsContext', () => ({
  useFeatureFlags: () => flagsState,
  useFeatureEnabled: () => false,
}));

const permissionsState = { hasAnyPermission: (_: string[]) => true, isLoading: false };
vi.mock('../../../contexts/PermissionsContext', () => ({
  usePermissions: () => permissionsState,
}));

// The settings barrel pulls in every tab; stub it down to the shell's needs.
vi.mock('../../../features/settings', () => {
  const Stub = () => null;
  return {
    useSettingsState: () => ({ isLoading: false }),
    FeaturesTab: Stub,
    GeneralTab: Stub,
    EventsTab: Stub,
    StatusTab: Stub,
    SecurityTab: Stub,
    ImageSecurityTab: Stub,
    CategoriesTab: Stub,
    AnalyticsTab: Stub,
    ModerationTab: Stub,
    StylingTab: Stub,
    SEOTab: Stub,
    ThumbnailsTab: Stub,
    DownloadsTab: Stub,
    ApiTokensTab: Stub,
    WebhooksTab: Stub,
    AccountingTab: Stub,
    WhatsAppTab: Stub,
    SsoTab: Stub,
  };
});

vi.mock('../EmailConfigPage', () => ({ EmailConfigPage: () => null }));
vi.mock('../BrandingPage', () => ({ BrandingPage: () => null }));
vi.mock('../EventTypesPage', () => ({ EventTypesPage: () => null }));
vi.mock('../SlideshowSettingsPage', () => ({ SlideshowSettingsPage: () => null }));
vi.mock('../BackupManagement', () => ({ BackupManagement: () => null }));
vi.mock('../CMSPage', () => ({ CMSPage: () => null }));
vi.mock('../settings/SettingsBusinessProfilePage', () => ({ SettingsBusinessProfilePage: () => null }));
vi.mock('../settings/CrmSettingsPage', () => ({ CrmSettingsPage: () => null }));
vi.mock('../settings/ReminderTemplatesPage', () => ({ ReminderTemplatesPage: () => null }));
vi.mock('../contracts/BlockLibraryPage', () => ({ BlockLibraryPage: () => null }));

import { SettingsPage } from '../SettingsPage';

function renderAt(tab: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/admin/settings?tab=${tab}`]}>
        <SettingsPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('SettingsPage fresh-mount permission race (QA J.08)', () => {
  beforeEach(() => {
    permissionsState.hasAnyPermission = () => true;
    permissionsState.isLoading = false;
  });

  it('does not crash on a deep-linked tab while permissions are still loading', () => {
    permissionsState.isLoading = true;
    permissionsState.hasAnyPermission = () => false;

    expect(() => renderAt('webhooks')).not.toThrow();
    expect(screen.getByText('settings.loadingSettings')).toBeInTheDocument();
  });

  it('still lands on the deep-linked tab once permissions arrive', () => {
    renderAt('webhooks');

    expect(screen.getByRole('heading', { level: 2, name: 'Webhooks' })).toBeInTheDocument();
  });

  it('does not crash when the role has no settings tab permissions at all', () => {
    permissionsState.hasAnyPermission = () => false;

    expect(() => renderAt('webhooks')).not.toThrow();
    expect(screen.getByText('settings.title')).toBeInTheDocument();
  });
});
