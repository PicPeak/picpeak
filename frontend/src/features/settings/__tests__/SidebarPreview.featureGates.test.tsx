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
    expect(screen.getByText('navigation.sharing')).toBeInTheDocument();
    expect(screen.getByText('navigation.settings')).toBeInTheDocument();
  });

  it.each([
    ['accounting', 'navigation.accounting'],
    // Analytics is no main-menu entry any more: it sits in the Sharing section.
    ['messaging', 'navigation.messages'],
  ] as const)('reflects the %s toggle', (flag, label) => {
    const { unmount } = render(<SidebarPreview staged={staged({ [flag]: false })} />);
    expect(screen.queryByText(label)).not.toBeInTheDocument();
    unmount();

    render(<SidebarPreview staged={staged({ [flag]: true })} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  // Section entries whose flags are an OR: the entry appears as soon as ONE
  // sub-feature is on, and only disappears when every one of them is off.
  // Getting this backwards would hide the section from an install that has
  // exactly one of its features enabled.
  it.each([
    ['navigation.automation', ['workflows', 'reminderEmails']],
  ] as const)('shows %s when any of its sub-features is on', (label, flags) => {
    const allOff = Object.fromEntries(flags.map((f) => [f, false])) as Partial<FeatureFlags>;
    const { unmount } = render(<SidebarPreview staged={staged(allOff)} />);
    expect(screen.queryByText(label)).not.toBeInTheDocument();
    unmount();

    for (const flag of flags) {
      const one = render(<SidebarPreview staged={staged({ ...allOff, [flag]: true })} />);
      expect(screen.getByText(label)).toBeInTheDocument();
      one.unmount();
    }
  });

  it('always lists Sharing, which has no flag of its own', () => {
    // Events is unconditional, so the section is too; PicTransfer's flag
    // decides an item inside it, not whether the entry exists.
    const { unmount } = render(<SidebarPreview staged={staged({ transfers: false })} />);
    expect(screen.getByText('navigation.sharing')).toBeInTheDocument();
    unmount();

    render(<SidebarPreview staged={staged({ transfers: true })} />);
    expect(screen.getByText('navigation.sharing')).toBeInTheDocument();
  });

  it('no longer offers Users as a sidebar entry', () => {
    // User management moved into Settings → People & access, so the preview
    // must not promise a main-menu entry that the sidebar will not render.
    render(<SidebarPreview staged={staged({ userManagement: true })} />);
    expect(screen.queryByText('navigation.users')).not.toBeInTheDocument();
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
