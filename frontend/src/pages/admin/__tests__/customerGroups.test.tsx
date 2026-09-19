/**
 * Customer groups in the admin UI (#1443).
 *
 * The overview opens on every customer, shows each one's groups by name with
 * their colour, filters by one or several groups through the server, and
 * resets. The catalogue tab covers its loading, empty and error states, and
 * refuses to offer a delete while customers are still in a group.
 *
 * The chips carry the group name as text and the colour only as a dot, so
 * nothing here depends on the colour being readable — that is what makes the
 * same markup work in light and dark mode.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({
      t: (k: string, fb?: unknown, opts?: Record<string, unknown>) => {
        const base = typeof fb === 'string' ? fb : k;
        const values = (typeof fb === 'object' && fb !== null ? fb : opts) as Record<string, unknown> | undefined;
        return values
          ? base.replace(/\{\{(\w+)\}\}/g, (_m, key) => String(values[key] ?? ''))
          : base;
      },
      i18n: { language: 'en' },
    }),
  };
});

vi.mock('react-toastify', () => ({
  toast: { success: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('../../../contexts/PermissionsContext', () => ({
  usePermissions: () => ({
    hasPermission: () => true,
    hasAnyPermission: () => true,
    hasAllPermissions: () => true,
    isSuperAdmin: true,
    isLoading: false,
  }),
}));

const list = vi.fn();
const listGroups = vi.fn();
const createGroup = vi.fn();
const deleteGroup = vi.fn();
vi.mock('../../../services/customerAdmin.service', () => ({
  customerAdminService: {
    list: (...a: unknown[]) => list(...a),
    listInvitations: vi.fn().mockResolvedValue([]),
    listGroups: (...a: unknown[]) => listGroups(...a),
    createGroup: (...a: unknown[]) => createGroup(...a),
    updateGroup: vi.fn(),
    deleteGroup: (...a: unknown[]) => deleteGroup(...a),
    reorderGroups: vi.fn(),
    setCustomerGroups: vi.fn(),
    createDirect: vi.fn(),
    sendInvite: vi.fn(),
    deactivate: vi.fn(),
    cancelInvitation: vi.fn(),
  },
}));

vi.mock('../../../services/businessProfile.service', () => ({
  businessProfileService: { get: vi.fn().mockResolvedValue({ profile: {} }) },
}));

import { CustomerManagementPage } from '../CustomerManagementPage';

const group = (id: number, name: string, extra: Record<string, unknown> = {}) => ({
  id, name, description: null, color: '#2563EB', sortOrder: id, isArchived: false, memberCount: 1, ...extra,
});

const customer = (id: number, email: string, groups: unknown[] = []) => ({
  id,
  email,
  displayName: `Customer ${id}`,
  firstName: null,
  lastName: null,
  salutation: null,
  companyName: null,
  isActive: true,
  isPassive: true,
  eventCount: 0,
  lastLogin: null,
  groups,
});

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <CustomerManagementPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const vip = group(1, 'VIP', { color: '#B91C1C' });
const press = group(2, 'Press', { color: '#15803D' });

beforeEach(() => {
  vi.clearAllMocks();
  listGroups.mockResolvedValue([vip, press]);
  list.mockResolvedValue([
    customer(10, 'grouped@example.com', [vip]),
    customer(11, 'ungrouped@example.com', []),
  ]);
});

describe('the overview', () => {
  it('opens on every customer and names each one\'s groups', async () => {
    renderPage();
    expect(await screen.findByText('grouped@example.com')).toBeInTheDocument();
    // Ungrouped customers are listed too, with nothing in the groups cell.
    expect(screen.getByText('ungrouped@example.com')).toBeInTheDocument();
    // The name is text, not only a colour.
    expect(screen.getAllByText('VIP').length).toBeGreaterThan(0);
    // No filter on the first load.
    expect(list).toHaveBeenCalledWith(undefined, []);
  });

  it('filters by one group, then two, and clears again', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('grouped@example.com');

    const filter = screen.getByRole('group', { name: 'Filter by group' });
    await user.click(within(filter).getByRole('button', { name: /VIP/ }));
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(undefined, [1]));

    await user.click(within(filter).getByRole('button', { name: /Press/ }));
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(undefined, [1, 2]));

    await user.click(screen.getByRole('button', { name: 'Clear' }));
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(undefined, []));
  });

  it('says so when a filter matches nobody', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('grouped@example.com');
    list.mockResolvedValue([]);

    const filter = screen.getByRole('group', { name: 'Filter by group' });
    await user.click(within(filter).getByRole('button', { name: /Press/ }));

    expect(await screen.findByText('No customers in the selected groups.')).toBeInTheDocument();
  });

  it('offers only live groups as a filter, and still shows an archived one on a customer', async () => {
    const retired = group(3, 'Retired', { isArchived: true });
    listGroups.mockResolvedValue([vip, press, retired]);
    list.mockResolvedValue([customer(12, 'carrier@example.com', [retired])]);
    renderPage();

    await screen.findByText('carrier@example.com');
    const filter = screen.getByRole('group', { name: 'Filter by group' });
    expect(within(filter).queryByRole('button', { name: /Retired/ })).toBeNull();
    // …but the chip on the row names it, in the row and in the phone copy
    // under the name (see the responsive test below).
    expect(screen.getAllByText('Retired').length).toBeGreaterThan(0);
  });

  it('puts the groups under the name for a phone, and drops the wide columns there', async () => {
    renderPage();
    await screen.findByText('grouped@example.com');

    // The Groups column and the ones that only make sense side by side are
    // hidden below the sm breakpoint; the name cell carries a copy instead,
    // so a phone shows who they are and which groups they are in without
    // scrolling the table sideways.
    const headers = screen.getAllByRole('columnheader');
    const byName = (name: string) => headers.find((h) => h.textContent?.trim() === name);
    expect(byName('Name')?.className).not.toContain('hidden');
    expect(byName('Email')?.className).not.toContain('hidden');
    expect(byName('Groups')?.className).toContain('hidden sm:table-cell');
    expect(byName('Company')?.className).toContain('hidden sm:table-cell');
    expect(byName('Last login')?.className).toContain('hidden md:table-cell');

    const nameCell = screen.getByText('grouped@example.com').closest('tr')?.querySelector('td');
    const phoneChips = nameCell?.querySelector('.sm\\:hidden');
    expect(phoneChips?.textContent).toContain('VIP');
  });
});

describe('the catalogue tab', () => {
  const openGroupsTab = async (user: ReturnType<typeof userEvent.setup>) => {
    await screen.findByText('grouped@example.com');
    await user.click(screen.getByRole('button', { name: /^Groups/ }));
  };

  it('lists the groups with their member counts', async () => {
    const user = userEvent.setup();
    renderPage();
    await openGroupsTab(user);
    // Two groups, each with one member.
    expect(await screen.findAllByText('1 customers')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'New group' })).toBeInTheDocument();
  });

  it('shows an empty state when there is no group yet', async () => {
    listGroups.mockResolvedValue([]);
    const user = userEvent.setup();
    renderPage();
    await openGroupsTab(user);
    expect(await screen.findByText('No groups yet. Create one to organise your customers.')).toBeInTheDocument();
  });

  it('shows an error state when the catalogue cannot be loaded', async () => {
    listGroups.mockRejectedValue(new Error('boom'));
    const user = userEvent.setup();
    renderPage();
    await openGroupsTab(user);
    expect(await screen.findByText('The groups could not be loaded. Reload the page to try again.')).toBeInTheDocument();
  });

  it('will not delete a group that still has customers in it', async () => {
    const user = userEvent.setup();
    renderPage();
    await openGroupsTab(user);
    const deleteButton = (await screen.findAllByRole('button', { name: 'Delete' }))[0];
    expect(deleteButton).toBeDisabled();
    expect(deleteGroup).not.toHaveBeenCalled();
  });

  it('creates a group from the form', async () => {
    listGroups.mockResolvedValue([]);
    createGroup.mockResolvedValue(group(4, 'Corporate'));
    const user = userEvent.setup();
    renderPage();
    await openGroupsTab(user);

    await user.click(await screen.findByRole('button', { name: 'New group' }));
    await user.type(screen.getByLabelText('Name'), 'Corporate');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(createGroup).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Corporate', color: expect.stringMatching(/^#[0-9A-F]{6}$/) }),
    ));
  });
});
