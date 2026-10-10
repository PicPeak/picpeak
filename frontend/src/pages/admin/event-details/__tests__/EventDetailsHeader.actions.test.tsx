/**
 * The gallery header's actions (review on 1833): the rename pen and the
 * Publish button show only to an admin who may edit a gallery that is not
 * archived, Rename is no longer a menu item, and both "⋯" menus anchor to the
 * right edge (from sm the menu starts a row that sits at the right edge).
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Event } from '../../../../types';
import { EventDetailsHeader } from '../EventDetailsHeader';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key), i18n: { language: 'en' } }),
  };
});
const perms = { granted: new Set<string>() };
vi.mock('../../../../contexts/PermissionsContext', () => ({
  usePermissions: () => ({
    hasPermission: (p: string) => perms.granted.has(p),
    hasAnyPermission: (ps: string[]) => ps.some((p) => perms.granted.has(p)),
  }),
}));
const flagState: { flags: Record<string, boolean> } = { flags: {} };
vi.mock('../../../../contexts/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({ flags: flagState.flags }),
  useFeatureEnabled: () => false,
}));
vi.mock('../../../../hooks/usePermission', () => ({
  usePermission: (p: string) => perms.granted.has(p),
  useAnyPermission: (ps: string[]) => ps.some((p) => perms.granted.has(p)),
}));
vi.mock('../../../../hooks/useLocalizedDate', () => ({ useLocalizedDate: () => ({ format: () => 'a date' }) }));
vi.mock('../../../../components/common/ConfirmDialog', () => ({ useConfirm: () => vi.fn() }));
vi.mock('../CompleteDeliveryDialog', () => ({ CompleteDeliveryDialog: () => null }));

const EVENT = {
  id: 7,
  slug: 'g',
  event_type: 'wedding',
  event_name: 'Hochzeit Muster',
  event_date: '2026-06-14',
  share_link: '/gallery/g/t',
  require_password: true,
  is_draft: true,
  is_archived: false,
  is_active: true,
} as unknown as Event;

const renderHeader = (event: Event = EVENT) => {
  const props = {
    setShowRenameDialog: vi.fn(),
    setShowPublishDialog: vi.fn(),
    setShowDuplicateDialog: vi.fn(),
    onSendGalleryEmail: vi.fn(),
    isSendingGalleryEmail: false,
    onArchive: vi.fn(),
    isPublishing: false,
    onExtendExpiration: vi.fn(),
    daysUntilExpiration: null,
    isExpired: false,
    isExpiring: false,
  };
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <EventDetailsHeader event={event} {...props} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return props;
};

const menuButtons = () => screen.queryAllByRole('button', { name: 'More actions' });

describe('EventDetailsHeader — actions', () => {
  beforeEach(() => {
    perms.granted = new Set(['events.edit', 'events.create', 'events.archive']);
    flagState.flags = {};
  });

  it('shows the rename pen and Publish to an editor, and each opens its dialog', () => {
    const props = renderHeader();
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    expect(props.setShowRenameDialog).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    expect(props.setShowPublishDialog).toHaveBeenCalledWith(true);
  });

  it('hides both without events.edit', () => {
    perms.granted = new Set(['events.create']);
    renderHeader();
    expect(screen.queryByRole('button', { name: 'Rename' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Publish' })).not.toBeInTheDocument();
  });

  it('hides both on an archived gallery', () => {
    renderHeader({ ...EVENT, is_archived: true } as Event);
    expect(screen.queryByRole('button', { name: 'Rename' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Publish' })).not.toBeInTheDocument();
  });

  it('no longer lists Rename in the "⋯" menu, and both menus open from their right edge', () => {
    renderHeader();
    const buttons = menuButtons();
    expect(buttons).toHaveLength(2); // the phone instance and the sm-up one
    for (const button of buttons) {
      fireEvent.click(button);
      const menu = screen.getByRole('menu');
      expect(within(menu).queryByRole('menuitem', { name: /rename/i })).not.toBeInTheDocument();
      expect(within(menu).getByRole('menuitem', { name: /duplicate/i })).toBeInTheDocument();
      expect(menu).toHaveClass('right-0');
      expect(menu).not.toHaveClass('left-0');
      fireEvent.click(button);
    }
  });
});
