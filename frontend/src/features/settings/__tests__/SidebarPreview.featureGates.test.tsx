/**
 * The "Sidebar preview" on Settings → Features kept its own hardcoded
 * 6-item array with 2 of the feature gates wired, so toggling e.g.
 * Workflows changed nothing in the preview (QA J.14). It now derives
 * from AdminSidebar's own `adminNavigation` declaration.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({ t: (k: string, fb?: unknown) => (typeof fb === 'string' ? fb : k) }),
  };
});

import { SidebarPreview } from '../components/SidebarPreview';
import { DEFAULT_FLAGS, type FeatureFlags } from '../../../contexts/FeatureFlagsContext';

const staged = (overrides: Partial<FeatureFlags>): FeatureFlags =>
  ({ ...DEFAULT_FLAGS, ...overrides }) as FeatureFlags;

describe('SidebarPreview feature gates (QA J.14)', () => {
  it('always lists the unconditional entries', () => {
    render(<SidebarPreview staged={staged({})} />);

    expect(screen.getByText('navigation.dashboard')).toBeInTheDocument();
    expect(screen.getByText('navigation.events')).toBeInTheDocument();
    expect(screen.getByText('navigation.settings')).toBeInTheDocument();
  });

  it.each([
    ['workflows', 'navigation.workflows'],
    ['transfers', 'navigation.transfers'],
    ['messaging', 'navigation.messages'],
    ['accounting', 'navigation.accounting'],
    ['analytics', 'admin.analytics'],
    ['userManagement', 'navigation.users'],
  ] as const)('reflects the %s toggle', (flag, label) => {
    const { unmount } = render(<SidebarPreview staged={staged({ [flag]: false })} />);
    expect(screen.queryByText(label)).not.toBeInTheDocument();
    unmount();

    render(<SidebarPreview staged={staged({ [flag]: true })} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it('shows the CRM entry only when one of its sub-features is on', () => {
    // `clients` is derived, so the entry needs a real sub-feature — mirrors
    // AdminSidebar's featureFlagsAny check.
    const { unmount } = render(<SidebarPreview staged={staged({ clients: true })} />);
    expect(screen.queryByText('navigation.clients')).not.toBeInTheDocument();
    unmount();

    render(<SidebarPreview staged={staged({ clients: true, contracts: true })} />);
    expect(screen.getByText('navigation.clients')).toBeInTheDocument();
  });
});
