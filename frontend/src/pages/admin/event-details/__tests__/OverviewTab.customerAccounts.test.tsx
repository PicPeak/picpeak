/**
 * The Details card lists the customer accounts assigned in Settings →
 * General while the customer portal is on, each linking to its customer page
 * when that page is reachable (the `clients` flag and customers.view).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { OverviewTab } from '../OverviewTab';
import type { Event } from '../../../../types';

const perms = vi.hoisted(() => ({ customersView: true }));
const flagState = vi.hoisted(() => ({ flags: { clients: true, customerPortal: true, newsletters: false } as Record<string, boolean> }));

vi.mock('../../../../hooks/usePermission', () => ({
  usePermission: (p: string) => (p === 'customers.view' ? perms.customersView : true),
  useAnyPermission: () => true,
}));
vi.mock('../../../../contexts/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({ flags: flagState.flags }),
  useFeatureEnabled: (key: string) => !!(flagState.flags as Record<string, unknown>)[key],
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key), i18n: { language: 'en' } }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));
vi.mock('../../../../hooks/useLocalizedDate', () => ({ useLocalizedDate: () => ({ format: () => 'a date' }) }));
// The cards around the Details card fetch on their own; not under test here.
vi.mock('../ShareLinkCard', () => ({ ShareLinkCard: () => null }));
vi.mock('../ClientAccessCard', () => ({ ClientAccessCard: () => null }));
vi.mock('../PhotoStatisticsCard', () => ({ PhotoStatisticsCard: () => null }));
vi.mock('../ArchiveStatusCard', () => ({ ArchiveStatusCard: () => null }));
vi.mock('../DownloadLimitUsage', () => ({ DownloadLimitUsage: () => null }));
vi.mock('../../../../components/admin/ShortUrlsCard', () => ({ ShortUrlsCard: () => null }));
vi.mock('../../../../components/admin', () => ({ FeedbackModerationPanel: () => null }));

const event = {
  id: 4,
  event_name: 'Wedding',
  customer_name: 'Nadine',
  customer_email: 'team@example.com',
  customer_accounts: [
    { id: 11, email: 'nico@example.com', display_name: null, first_name: 'Nico', last_name: 'Beispiel' },
    { id: 12, email: 'team@example.com', display_name: null, first_name: null, last_name: null },
    { id: 13, email: 'studio@example.com', display_name: 'Studio Nord', first_name: 'Ana', last_name: 'Nord' },
  ],
} as unknown as Event;

function renderTab(e: Event = event) {
  return render(
    <MemoryRouter>
      <OverviewTab
        event={e}
        id="4"
        feedbackSettings={undefined}
        categories={[]}
        daysUntilExpiration={null}
        refetchEvent={() => {}}
        setActiveTab={() => {}}
        openSettings={() => {}}
        setShowPasswordReset={() => {}}
        onSendGalleryEmail={() => {}}
        isSendingGalleryEmail={false}
        onExtendExpiration={() => {}}
        isExtending={false}
        onRevealNow={() => {}}
      />
    </MemoryRouter>,
  );
}

const accountsRow = () => screen.getByText('Customer accounts').parentElement as HTMLElement;

describe('OverviewTab — assigned customer accounts', () => {
  beforeEach(() => {
    perms.customersView = true;
    flagState.flags = { clients: true, customerPortal: true, newsletters: false };
  });

  it('lists each account by display name, else first + last, else email, linked to its customer page', () => {
    renderTab();
    const links = within(accountsRow()).getAllByRole('link');
    expect(links.map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['Nico Beispiel', '/admin/clients/accounts/11'],
      ['team@example.com', '/admin/clients/accounts/12'],
      ['Studio Nord', '/admin/clients/accounts/13'],
    ]);
  });

  it('shows the names without links when the role cannot open customers', () => {
    perms.customersView = false;
    renderTab();
    expect(within(accountsRow()).queryAllByRole('link')).toHaveLength(0);
    expect(within(accountsRow()).getByText('Nico Beispiel')).toBeInTheDocument();
  });

  it('shows the names without links when the clients section is switched off', () => {
    flagState.flags = { clients: false, customerPortal: true, newsletters: false };
    renderTab();
    expect(within(accountsRow()).queryAllByRole('link')).toHaveLength(0);
  });

  // The row is the customer portal's (PR 1819 gated it on the flag), so with
  // the portal off there is no row, and no link to a page the install may
  // not serve: newsletters alone opens the customer page, but assigning
  // portal accounts to a gallery is a portal feature.
  it('has no row with the customer portal off', () => {
    flagState.flags = { clients: true, customerPortal: false, newsletters: false };
    renderTab();
    expect(screen.queryByText('Customer accounts')).toBeNull();
  });

  it('has no row with the portal off on a newsletters-only install either', () => {
    flagState.flags = { clients: true, customerPortal: false, newsletters: true };
    renderTab();
    expect(screen.queryByText('Customer accounts')).toBeNull();
  });

  it('has no row when no account is assigned', () => {
    renderTab({ ...event, customer_accounts: [] } as unknown as Event);
    expect(screen.queryByText('Customer accounts')).toBeNull();
  });
});
