/**
 * Customer groups where an admin picks a customer (#1443): the search results
 * of both pickers, the customer a CRM editor has selected, and the customers
 * assigned to an event carry their group chips, so nobody has to open the
 * record to see the segment. The selected customer's groups are only fetched
 * with customers.view.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({
      t: (k: string, fb?: unknown, opts?: Record<string, unknown>) => {
        const values = (typeof fb === 'object' && fb !== null ? fb : opts) as Record<string, unknown> | undefined;
        const base = typeof fb === 'string' ? fb : k;
        return values ? base.replace(/\{\{(\w+)\}\}/g, (_m, key) => String(values[key] ?? '')) : base;
      },
    }),
  };
});

vi.mock('../../../contexts/FeatureFlagsContext', () => ({ useFeatureEnabled: () => true }));
let canCreate = false;
vi.mock('../../../hooks/usePermission', () => ({ usePermission: () => canCreate }));
let createdCustomer: unknown = null;
vi.mock('../InlineCustomerCreate', () => ({
  InlineCustomerCreate: ({ onCreated }: { onCreated: (c: unknown) => void }) => (
    <button type="button" onClick={() => onCreated(createdCustomer)}>finish-create</button>
  ),
}));

const search = vi.fn();
const get = vi.fn();
vi.mock('../../../services/customerAdmin.service', () => ({
  customerAdminService: {
    search: (...a: unknown[]) => search(...a),
    get: (...a: unknown[]) => get(...a),
  },
}));

import { PermissionsContext } from '../../../contexts/PermissionsContext';
import { CustomerPicker } from '../CustomerPicker';
import { CustomerAccountPicker } from '../CustomerAccountPicker';

const group = (id: number, name: string) => ({
  id, name, description: null, color: '#2563EB', sortOrder: id, isArchived: false,
});
const groups = [group(1, 'VIP'), group(2, 'Press'), group(3, 'Wedding')];
const found = {
  id: 7, email: 'found@example.com', displayName: 'Found', firstName: null, lastName: null,
  salutation: null, companyName: null, isActive: true, lastLogin: null, createdAt: '', groups,
};

const withProviders = (node: React.ReactNode, permissions: string[] | null) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ctx = permissions && {
    permissions, hasPermission: (p: string) => permissions.includes(p),
    hasAnyPermission: () => true, hasAllPermissions: () => true, isSuperAdmin: false, isLoading: false,
  };
  return render(
    <QueryClientProvider client={qc}>
      {ctx
        ? <PermissionsContext.Provider value={ctx as never}>{node}</PermissionsContext.Provider>
        : node}
    </QueryClientProvider>,
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  canCreate = false;
  createdCustomer = null;
  search.mockResolvedValue([found]);
  get.mockResolvedValue({ ...found });
});

const pickerProps = { onSelect: vi.fn(), onCreate: vi.fn(), onClear: vi.fn(), isPassive: false };

describe('CustomerPicker', () => {
  it('shows each search result\'s groups, bounded, without a button inside the option', async () => {
    const user = userEvent.setup();
    withProviders(<CustomerPicker value={null} label="" {...pickerProps} />, ['customers.view']);
    await user.type(screen.getByRole('textbox'), 'found');
    const option = await screen.findByRole('button', { name: /found@example.com/ });
    expect(within(option).getByText('VIP')).toBeInTheDocument();
    expect(within(option).getByText('Press')).toBeInTheDocument();
    expect(within(option).queryByText('Wedding')).toBeNull();
    expect(within(option).getByText('+1')).toBeInTheDocument();
    expect(within(option).queryByRole('button')).toBeNull();
  });

  it('shows the selected customer\'s groups with customers.view', async () => {
    withProviders(<CustomerPicker value={7} label="Found" {...pickerProps} />, ['customers.view']);
    expect(await screen.findByText('VIP')).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith(7);
  });

  it('does not ask for the selected customer without customers.view, or without a permissions provider', () => {
    const { unmount } = withProviders(<CustomerPicker value={7} label="Found" {...pickerProps} />, ['bills.view']);
    unmount();
    withProviders(<CustomerPicker value={7} label="Found" {...pickerProps} />, null);
    expect(screen.getByText('Found')).toBeInTheDocument();
    expect(get).not.toHaveBeenCalled();
  });
});

describe('CustomerAccountPicker', () => {
  it('shows the groups of an assigned customer and of each search result', async () => {
    const user = userEvent.setup();
    withProviders(
      <CustomerAccountPicker
        value={[{ id: 3, email: 'assigned@example.com', displayName: null, groups: [group(4, 'Family')] }]}
        onChange={() => {}}
      />,
      null,
    );
    expect(screen.getByText('Family')).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText('Search by email, name, or company'), 'found');
    const option = await screen.findByRole('button', { name: /found@example.com/ });
    expect(within(option).getByText('VIP')).toBeInTheDocument();
    expect(within(option).queryByRole('button')).toBeNull();
  });

  it('keeps the groups of a customer picked from the search', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    withProviders(<CustomerAccountPicker value={[]} onChange={onChange} />, null);
    await user.type(screen.getByPlaceholderText('Search by email, name, or company'), 'found');
    await user.click(await screen.findByRole('button', { name: /found@example.com/ }));
    expect(onChange).toHaveBeenCalledWith([expect.objectContaining({ id: 7, groups })]);
  });

  it('keeps the groups of a customer created inline', async () => {
    canCreate = true;
    createdCustomer = { ...found, id: 8, email: 'new@example.com' };
    const onChange = vi.fn();
    const user = userEvent.setup();
    withProviders(<CustomerAccountPicker value={[]} onChange={onChange} />, null);
    await user.click(screen.getByRole('button', { name: '+ Create new customer' }));
    await user.click(screen.getByRole('button', { name: 'finish-create' }));
    expect(onChange).toHaveBeenCalledWith([expect.objectContaining({ id: 8, groups })]);
  });
});
