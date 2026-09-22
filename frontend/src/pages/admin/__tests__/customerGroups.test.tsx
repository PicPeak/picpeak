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
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({
      t: (k: string, fb?: unknown, opts?: Record<string, unknown>) => {
        const values = (typeof fb === 'object' && fb !== null ? fb : opts) as Record<string, unknown> | undefined;
        // Plural keys carry their English forms as defaultValue_one/_other.
        const plural = values?.[values?.count === 1 ? 'defaultValue_one' : 'defaultValue_other'];
        const base = typeof fb === 'string' ? fb : typeof plural === 'string' ? plural : k;
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

// customers.groups.manage is the only permission this page asks about.
const hasPermission = vi.fn((_name: string) => true);
vi.mock('../../../contexts/PermissionsContext', () => ({
  usePermissions: () => ({
    hasPermission: (name: string) => hasPermission(name),
    hasAnyPermission: () => true,
    hasAllPermissions: () => true,
    isSuperAdmin: true,
    isLoading: false,
  }),
}));

const list = vi.fn();
const listGroups = vi.fn();
let ungroupedCount = 1;
const createGroup = vi.fn();
const deleteGroup = vi.fn();
const bulkAssignGroups = vi.fn();
vi.mock('../../../services/customerAdmin.service', () => ({
  BULK_GROUP_MAX_CUSTOMERS: 500,
  MAX_GROUPS_PER_CUSTOMER: 100,
  customerAdminService: {
    list: (...a: unknown[]) => list(...a),
    listInvitations: vi.fn().mockResolvedValue([]),
    listGroups: (...a: unknown[]) => listGroups(...a),
    listGroupCatalogue: async (...a: unknown[]) => ({ groups: await listGroups(...a), ungroupedCount }),
    createGroup: (...a: unknown[]) => createGroup(...a),
    updateGroup: vi.fn(),
    deleteGroup: (...a: unknown[]) => deleteGroup(...a),
    reorderGroups: vi.fn(),
    setCustomerGroups: vi.fn(),
    bulkAssignGroups: (...a: unknown[]) => bulkAssignGroups(...a),
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
import en from '../../../i18n/locales/en.json';
import de from '../../../i18n/locales/de.json';

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

/** The query string the page has written, for the URL assertions. */
const LocationProbe = () => <output data-testid="location">{useLocation().search}</output>;
const currentSearch = () => screen.getByTestId('location').textContent;
/** Stands in for Back/Forward or a pasted link: a navigation the page didn't make. */
const NavigateProbe = () => {
  const navigate = useNavigate();
  return <button type="button" onClick={() => navigate('/admin/clients/accounts?q=second')}>external-nav</button>;
};

/** renderPage, plus a way to make the catalogue query see a changed catalogue. */
function renderPageWithClient(url = '/admin/clients/accounts') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[url]}>
        <CustomerManagementPage />
        <LocationProbe />
        <NavigateProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return {
    ...utils,
    rerenderWithGroups: async (groups: unknown[]) => {
      listGroups.mockResolvedValue(groups);
      await qc.invalidateQueries({ queryKey: ['admin-customer-groups'] });
    },
  };
}

const renderPage = (url?: string) => renderPageWithClient(url);

/** What the page asks the service for, defaults filled in. */
const listArgs = (overrides: Record<string, unknown> = {}) => ({
  groupIds: [], groupMatch: 'any', ungrouped: false, status: 'all', ...overrides,
});

const vip = group(1, 'VIP', { color: '#B91C1C' });
const press = group(2, 'Press', { color: '#15803D' });

beforeEach(() => {
  vi.clearAllMocks();
  ungroupedCount = 1;
  hasPermission.mockImplementation(() => true);
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
    expect(list).toHaveBeenCalledWith(listArgs());
  });

  it('filters by one group, then two, and clears again', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('grouped@example.com');

    const filter = screen.getByRole('group', { name: 'Filter by group' });
    await user.click(within(filter).getByRole('button', { name: /VIP/ }));
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(listArgs({ groupIds: [1] })));

    await user.click(within(filter).getByRole('button', { name: /Press/ }));
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(listArgs({ groupIds: [1, 2] })));

    await user.click(screen.getByRole('button', { name: 'Clear' }));
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(listArgs()));
  });

  it('says so when a filter matches nobody', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('grouped@example.com');
    list.mockResolvedValue([]);

    const filter = screen.getByRole('group', { name: 'Filter by group' });
    await user.click(within(filter).getByRole('button', { name: /Press/ }));

    expect(await screen.findByText('No customers match these filters.')).toBeInTheDocument();
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

  it('keeps every column in view: the email under the name, and the wide columns stepping aside', async () => {
    list.mockResolvedValue([
      { ...customer(10, 'grouped@example.com', [vip]), companyName: 'Acme' },
      customer(11, 'ungrouped@example.com', []),
    ]);
    renderPage();
    await screen.findByText('grouped@example.com');

    const headers = screen.getAllByRole('columnheader');
    const byName = (name: string) => headers.find((h) => h.textContent?.trim() === name);
    // No Email column at any width: the address is in the name cell, so it
    // can't wrap into a narrow column on a phone or push Status and the row
    // action out of the ~760px card at 1440.
    expect(byName('Email')).toBeUndefined();
    expect(byName('Name')?.className).not.toContain('hidden');
    // On a phone only the name cell shows…
    for (const name of ['Groups', 'Events', 'Status']) {
      expect(byName(name)?.className).toContain('hidden sm:table-cell');
    }
    // …and below 2xl (1440 leaves the card ~760px) Company and Last login
    // step aside as well.
    expect(byName('Company')?.className).toContain('hidden 2xl:table-cell');
    expect(byName('Last login')?.className).toContain('hidden 2xl:table-cell');

    const nameCell = screen.getByText('grouped@example.com').closest('td');
    expect(nameCell).toBe(screen.getByText('grouped@example.com').closest('tr')?.querySelector('td'));
    // The address may break only after "@" and ".", never inside a word.
    const address = screen.getByText('grouped@example.com');
    expect(address.className).not.toMatch(/break-all|overflow-wrap:anywhere/);
    expect([...address.childNodes].map((node) => (node.nodeName === 'WBR' ? '|' : node.textContent)).join(''))
      .toBe('grouped@|example.|com');
    expect(nameCell?.className).toContain('min-w-');
    // The company follows it where the Company column is hidden.
    const companyCopy = [...(nameCell?.querySelectorAll('[class~="2xl:hidden"]') ?? [])].map((el) => el.textContent);
    expect(companyCopy).toContain('Acme');
    // The email comes before the chips and the status in the name cell.
    const text = nameCell?.textContent || '';
    expect(text.indexOf('grouped@example.com')).toBeLessThan(text.indexOf('VIP'));

    const phoneChips = nameCell?.querySelector('.sm\\:hidden');
    expect(phoneChips?.textContent).toContain('VIP');
    // The status column is hidden on a phone too, so its copy under the name
    // has to say everything the column says — the passive badge included.
    const phoneCopy = [...(nameCell?.querySelectorAll('.sm\\:hidden') ?? [])].map((el) => el.textContent).join(' ');
    expect(phoneCopy).toContain('Active');
    expect(phoneCopy).toContain('Passive — admin only');
    // The row action and the status stay columns from sm up.
    const row = nameCell?.closest('tr');
    const action = within(row as HTMLElement).getByRole('button', { name: 'Deactivate grouped@example.com' });
    expect(action.closest('td')?.className).toContain('sm:table-cell');
    // Icon-only below 2xl, with the same name as a tooltip.
    expect(action).toHaveAttribute('title', 'Deactivate grouped@example.com');
    expect(within(action).getByText('Deactivate').className).toContain('hidden 2xl:inline');
  });

  it('drops a selected group from the filter once it is archived, instead of filtering by it with nothing to switch it off', async () => {
    const user = userEvent.setup();
    listGroups.mockResolvedValue([vip]);
    const { rerenderWithGroups } = renderPageWithClient();
    await screen.findByText('grouped@example.com');
    await user.click(screen.getByRole('button', { name: /VIP/ }));
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(listArgs({ groupIds: [1] })));

    // Archived from the Groups tab (or by another admin): no live group is left.
    await rerenderWithGroups([{ ...vip, isArchived: true }]);
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(listArgs()));
    expect(screen.getByText('ungrouped@example.com')).toBeInTheDocument();
  });
});

describe('filters in the URL', () => {
  it('reads a deep link into the filter and the request', async () => {
    renderPage('/admin/clients/accounts?groups=1,2&match=all&status=active');
    await screen.findByText('grouped@example.com');
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(listArgs({ groupIds: [1, 2], groupMatch: 'all', status: 'active' })));
    const filter = screen.getByRole('group', { name: 'Filter by group' });
    expect(within(filter).getByRole('button', { name: /VIP/ })).toHaveAttribute('aria-pressed', 'true');
    expect(within(filter).getByRole('button', { name: /Press/ })).toHaveAttribute('aria-pressed', 'true');
    expect(within(filter).getByRole('button', { name: 'All of them' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('combobox', { name: 'Status' })).toHaveValue('active');
  });

  it('writes every change back to the URL, offers Any/All only for two groups, and Clear empties it', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('grouped@example.com');
    const filter = screen.getByRole('group', { name: 'Filter by group' });

    await user.click(within(filter).getByRole('button', { name: /VIP/ }));
    await waitFor(() => expect(currentSearch()).toBe('?groups=1'));
    expect(within(filter).queryByRole('button', { name: 'All of them' })).toBeNull();

    await user.click(within(filter).getByRole('button', { name: /Press/ }));
    await user.click(within(filter).getByRole('button', { name: 'All of them' }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'inactive');
    await waitFor(() => expect(new URLSearchParams(currentSearch() || '').toString())
      .toBe(new URLSearchParams({ groups: '1,2', match: 'all', status: 'inactive' }).toString()));
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(listArgs({ groupIds: [1, 2], groupMatch: 'all', status: 'inactive' })));

    await user.type(screen.getByPlaceholderText('Search by email, name, or company'), 'grouped');
    await waitFor(() => expect(currentSearch()).toContain('q=grouped'));

    await user.click(within(filter).getByRole('button', { name: 'Clear' }));
    await waitFor(() => expect(currentSearch()).toBe(''));
    expect(screen.getByPlaceholderText('Search by email, name, or company')).toHaveValue('');
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(listArgs()));
  });

  it('shows a q that arrives by navigation in the search box, and does not overwrite it', async () => {
    const user = userEvent.setup();
    renderPage('/admin/clients/accounts?q=first');
    const box = screen.getByPlaceholderText('Search by email, name, or company');
    expect(box).toHaveValue('first');

    await user.click(screen.getByRole('button', { name: 'external-nav' }));
    await waitFor(() => expect(box).toHaveValue('second'));
    // Past the debounce: the box did not write its old value back.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(currentSearch()).toBe('?q=second');

    // Typing still reaches the URL.
    await user.type(box, 'x');
    await waitFor(() => expect(currentSearch()).toBe('?q=secondx'));
  });

  it('keeps the tab in the URL', async () => {
    const user = userEvent.setup();
    renderPage('/admin/clients/accounts?tab=groups');
    expect(await screen.findByRole('button', { name: 'New group' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^Customers/ }));
    await waitFor(() => expect(currentSearch()).toBe(''));
  });

  it('drops a stale group id from the request and from the URL', async () => {
    renderPage('/admin/clients/accounts?groups=1,99&match=all');
    await screen.findByText('grouped@example.com');
    await waitFor(() => expect(currentSearch()).toBe('?groups=1'));
    expect(list).toHaveBeenLastCalledWith(listArgs({ groupIds: [1], groupMatch: 'any' }));
    expect(list).not.toHaveBeenCalledWith(expect.objectContaining({ groupIds: [1, 99] }));
  });

  it('filters to the ungrouped customers, with their count, instead of any group', async () => {
    ungroupedCount = 4;
    const user = userEvent.setup();
    renderPage('/admin/clients/accounts?groups=1');
    await screen.findByText('grouped@example.com');
    const filter = screen.getByRole('group', { name: 'Filter by group' });
    const pill = within(filter).getByRole('button', { name: /Ungrouped/ });
    expect(pill).toHaveTextContent('4');

    await user.click(pill);
    await waitFor(() => expect(currentSearch()).toBe('?ungrouped=1'));
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(listArgs({ ungrouped: true })));
    expect(within(filter).getByRole('button', { name: /VIP/ })).toHaveAttribute('aria-pressed', 'false');

    // Picking a group again leaves "Ungrouped".
    await user.click(within(filter).getByRole('button', { name: /VIP/ }));
    await waitFor(() => expect(currentSearch()).toBe('?groups=1'));
  });

  it('tells "no customers yet" apart from "nobody matches", and offers a way back from the second', async () => {
    list.mockResolvedValue([]);
    const first = renderPage();
    expect(await screen.findByText('No customers yet. Click "Invite customer" to add one.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull();
    first.unmount();

    // A search with no hits, and no group filter: not "no customers yet".
    list.mockResolvedValue([customer(10, 'grouped@example.com', [vip])]);
    const user = userEvent.setup();
    renderPage('/admin/clients/accounts?q=nobody-by-this-name');
    expect(await screen.findByText('No customers match these filters.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(await screen.findByText('grouped@example.com')).toBeInTheDocument();
    expect(currentSearch()).toBe('');
  });
});

describe('bulk group changes', () => {
  const rowBox = (email: string) => screen.getByRole('checkbox', { name: `Select ${email}` });

  it('offers no selection without customers.groups.manage', async () => {
    hasPermission.mockImplementation((name) => name !== 'customers.groups.manage');
    renderPage();
    await screen.findByText('grouped@example.com');
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('selects all the rows the filter shows, and drops the selection when the filter changes', async () => {
    const user = userEvent.setup();
    renderPage('/admin/clients/accounts?q=ungrouped');
    await screen.findByText('ungrouped@example.com');
    expect(screen.queryByText('grouped@example.com')).toBeNull();

    await user.click(screen.getByRole('checkbox', { name: 'Select all shown customers' }));
    expect(rowBox('ungrouped@example.com')).toBeChecked();
    expect(within(screen.getByRole('region', { name: 'Selected customers' })).getByText('1 selected')).toBeInTheDocument();

    const filter = screen.getByRole('group', { name: 'Filter by group' });
    await user.click(within(filter).getByRole('button', { name: /Press/ }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Selected customers' })).toBeNull());
  });

  it('allows no selection while the rows on screen are still the previous filter\'s', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('ungrouped@example.com');
    let resolveFiltered: (rows: unknown[]) => void = () => {};
    list.mockImplementationOnce(() => new Promise((resolve) => { resolveFiltered = resolve; }));

    const filter = screen.getByRole('group', { name: 'Filter by group' });
    await user.click(within(filter).getByRole('button', { name: /Press/ }));
    await waitFor(() => expect(rowBox('ungrouped@example.com')).toBeDisabled());
    expect(screen.getByRole('checkbox', { name: 'Select all shown customers' })).toBeDisabled();

    resolveFiltered([customer(12, 'press@example.com', [press])]);
    await waitFor(() => expect(rowBox('press@example.com')).toBeEnabled());
  });

  it('previews the effective change, confirms with the consequence, and clears the selection', async () => {
    bulkAssignGroups.mockImplementation(async (payload: { dryRun?: boolean }) => ({
      customers: 2, added: 1, removed: 0, perGroup: [{ groupId: 1, added: 1, removed: 0 }], dryRun: !!payload.dryRun,
    }));
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('grouped@example.com');
    await user.click(rowBox('grouped@example.com'));
    await user.click(rowBox('ungrouped@example.com'));
    await user.click(screen.getByRole('button', { name: 'Add to groups…' }));

    const dialog = screen.getByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: /Add \d+ membership/ });
    expect(confirm).toBeDisabled();
    await user.click(within(dialog).getByRole('checkbox', { name: /VIP/ }));
    expect(await within(dialog).findByText('Adds 1 membership.')).toBeInTheDocument();
    expect(within(dialog).getByText('1 customer is already in VIP.')).toBeInTheDocument();
    expect(bulkAssignGroups).toHaveBeenCalledWith({ customerIds: [10, 11], addGroupIds: [1], dryRun: true });

    await user.click(within(dialog).getByRole('button', { name: 'Add 1 membership' }));
    await waitFor(() => expect(bulkAssignGroups).toHaveBeenLastCalledWith({ customerIds: [10, 11], addGroupIds: [1] }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByRole('region', { name: 'Selected customers' })).toBeNull();
  });

  it('names the customers a change would take past the group limit, and keeps the confirm button off', async () => {
    bulkAssignGroups.mockRejectedValue(Object.assign(new Error('Request failed'), {
      response: { status: 400, data: { error: 'x', code: 'BULK_GROUP_LIMIT', details: { customers: 2, limit: 100 } } },
    }));
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('grouped@example.com');
    await user.click(rowBox('grouped@example.com'));
    await user.click(screen.getByRole('button', { name: 'Add to groups…' }));
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('checkbox', { name: /VIP/ }));
    expect(await within(dialog).findByText(
      '2 selected customers would be in more than 100 groups. Take them out of the selection, or out of other groups first.',
    )).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /Add \d+ membership/ })).toBeDisabled();
  });

  it('keeps the confirm button off when the change would do nothing', async () => {
    bulkAssignGroups.mockResolvedValue({
      customers: 1, added: 0, removed: 0, perGroup: [{ groupId: 1, added: 0, removed: 0 }], dryRun: true,
    });
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('grouped@example.com');
    await user.click(rowBox('grouped@example.com'));
    await user.click(screen.getByRole('button', { name: 'Add to groups…' }));
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('checkbox', { name: /VIP/ }));
    expect(await within(dialog).findByText('Adds 0 memberships.')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Add 0 memberships' })).toBeDisabled();
    expect(bulkAssignGroups).toHaveBeenCalledTimes(1);
  });

  it('turns the bulk actions off, and says why, above the server\'s 500-customer cap', async () => {
    list.mockResolvedValue(Array.from({ length: 501 }, (_, i) => customer(1000 + i, `bulk-${i}@example.com`)));
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('bulk-0@example.com');
    await user.click(screen.getByRole('checkbox', { name: 'Select all shown customers' }));

    const bar = screen.getByRole('region', { name: 'Selected customers' });
    expect(within(bar).getByText('501 selected')).toBeInTheDocument();
    expect(within(bar).getByRole('button', { name: 'Add to groups…' })).toBeDisabled();
    expect(within(bar).getByRole('button', { name: 'Remove from groups…' })).toBeDisabled();
    expect(within(bar).getByText(/At most 500 customers can be changed at once/)).toBeInTheDocument();

    // One fewer and it is allowed again.
    await user.click(screen.getByRole('checkbox', { name: 'Select bulk-0@example.com' }));
    expect(within(bar).getByRole('button', { name: 'Add to groups…' })).toBeEnabled();
    expect(within(bar).queryByText(/At most 500 customers/)).toBeNull();
  }, 30000);

  it('offers for removal only the groups the selection carries', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('grouped@example.com');
    await user.click(rowBox('grouped@example.com'));
    await user.click(screen.getByRole('button', { name: 'Remove from groups…' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('checkbox', { name: /VIP/ })).toBeInTheDocument();
    expect(within(dialog).queryByRole('checkbox', { name: /Press/ })).toBeNull();
  });
});

describe('the overview states', () => {
  it('shows a spinner while the customers load', async () => {
    list.mockReturnValue(new Promise(() => {}));
    const { container } = renderPage();
    await waitFor(() => expect(container.querySelector('.animate-spin')).not.toBeNull());
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('says why when a filter holds more groups than the server takes', async () => {
    list.mockRejectedValue(Object.assign(new Error('Request failed'), {
      response: { status: 400, data: { error: 'x', code: 'GROUP_FILTER_TOO_MANY', details: { limit: 100 } } },
    }));
    renderPage();
    expect(await screen.findByText('Filter by at most 100 groups at once.')).toBeInTheDocument();
  });

  it('says so when the customers cannot be loaded', async () => {
    list.mockRejectedValue(new Error('boom'));
    renderPage();
    expect(await screen.findByText('Could not load customers')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('shows markup in a group name as text, never as an element', async () => {
    const markup = '<img src=x onerror=alert(1)>';
    list.mockResolvedValue([customer(13, 'markup@example.com', [group(9, markup)])]);
    listGroups.mockResolvedValue([group(9, markup)]);
    const { container } = renderPage();
    await screen.findByText('markup@example.com');
    expect(screen.getAllByText(markup).length).toBeGreaterThan(0);
    expect(container.querySelector('img')).toBeNull();
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
    expect(await screen.findAllByText('1 customer')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'New group' })).toBeInTheDocument();
  });

  it('counts in the plural for anything but one, in both shipped locales', async () => {
    listGroups.mockResolvedValue([group(1, 'Empty', { memberCount: 0 }), group(2, 'Pair', { memberCount: 2 })]);
    const user = userEvent.setup();
    renderPage();
    await openGroupsTab(user);
    expect(await screen.findByText('0 customers')).toBeInTheDocument();
    expect(screen.getByText('2 customers')).toBeInTheDocument();
    for (const locale of [en, de]) {
      expect(locale.customers.groups.memberCount_one).toContain('{{count}}');
      expect(locale.customers.groups.memberCount_other).toContain('{{count}}');
    }
  });

  it('is read-only without customers.groups.manage: the catalogue, and no control that would only answer 403', async () => {
    hasPermission.mockImplementation((name) => name !== 'customers.groups.manage');
    const user = userEvent.setup();
    renderPage();
    await openGroupsTab(user);
    expect(await screen.findAllByText('1 customer')).toHaveLength(2);
    for (const name of ['New group', 'Edit', 'Delete', 'Archive', 'Move up', 'Move down']) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
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
    // Clicking it anyway opens no confirmation and sends nothing.
    const before = screen.getAllByRole('button', { name: /Delete/ }).length;
    await user.click(deleteButton);
    expect(screen.getAllByRole('button', { name: /Delete/ })).toHaveLength(before);
    expect(deleteGroup).not.toHaveBeenCalled();
  });

  it('deletes an empty group, after a confirmation', async () => {
    listGroups.mockResolvedValue([group(5, 'Empty', { memberCount: 0 })]);
    deleteGroup.mockResolvedValue({ deleted: true });
    const user = userEvent.setup();
    renderPage();
    await openGroupsTab(user);
    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    expect(deleteGroup).not.toHaveBeenCalled();
    const buttons = screen.getAllByRole('button', { name: /Delete/ });
    await user.click(buttons[buttons.length - 1]);
    await waitFor(() => expect(deleteGroup).toHaveBeenCalledWith(5));
  });

  it('names the palette colours for a screen reader instead of reading out hex values', async () => {
    const user = userEvent.setup();
    renderPage();
    await openGroupsTab(user);
    await user.click(await screen.findByRole('button', { name: 'New group' }));
    for (const name of ['Blue', 'Green', 'Amber', 'Red', 'Violet', 'Teal', 'Pink', 'Grey']) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
    expect(screen.queryByRole('button', { name: /^#/ })).not.toBeInTheDocument();
    expect(Object.keys(en.customers.groups.palette)).toEqual(Object.keys(de.customers.groups.palette));
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

  it('warns about a colour that is hard to see in one theme, and not about the palette', async () => {
    const user = userEvent.setup();
    renderPage();
    await openGroupsTab(user);
    await user.click(await screen.findByRole('button', { name: 'New group' }));
    const custom = screen.getByLabelText('Custom colour');

    for (const name of ['Blue', 'Green', 'Amber', 'Red', 'Violet', 'Teal', 'Pink', 'Grey']) {
      await user.click(screen.getByRole('button', { name }));
      expect(screen.queryByText(/hard to see/)).toBeNull();
    }
    fireEvent.input(custom, { target: { value: '#ffffff' } });
    expect(await screen.findByText('This colour is hard to see in light mode.')).toBeInTheDocument();
    fireEvent.input(custom, { target: { value: '#000000' } });
    expect(await screen.findByText('This colour is hard to see in dark mode.')).toBeInTheDocument();
  });
});
