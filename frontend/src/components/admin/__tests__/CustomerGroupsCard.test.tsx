/**
 * Customer detail → Groups card.
 *
 * Read-only without customers.groups.manage. With it, the picker sends the
 * whole set in one replace, keeps an archived group the customer already
 * carries (checked, and the way out of it), and never offers an archived
 * group to a customer who isn't in it.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({ t: (k: string, fb?: unknown) => (typeof fb === 'string' ? fb : k) }),
  };
});

vi.mock('react-toastify', () => ({
  toast: { success: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const listGroups = vi.fn();
const setCustomerGroups = vi.fn();
vi.mock('../../../services/customerAdmin.service', () => ({
  customerAdminService: {
    listGroups: (...a: unknown[]) => listGroups(...a),
    setCustomerGroups: (...a: unknown[]) => setCustomerGroups(...a),
  },
}));

import { CustomerGroupsCard } from '../CustomerGroupsCard';

const group = (id: number, name: string, isArchived = false) => ({
  id, name, description: null, color: '#2563EB', sortOrder: id, isArchived,
});
const vip = group(1, 'VIP');
const retired = group(2, 'Retired', true);
const press = group(3, 'Press');
const otherRetired = group(4, 'Long gone', true);

const renderCard = (canManage: boolean) => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <CustomerGroupsCard customerId={7} groups={[vip, retired]} canManage={canManage} />
  </QueryClientProvider>,
);

beforeEach(() => {
  vi.clearAllMocks();
  listGroups.mockResolvedValue([vip, retired, press, otherRetired]);
  setCustomerGroups.mockResolvedValue([vip, press]);
});

describe('CustomerGroupsCard', () => {
  it('shows the groups and nothing to change them with, without customers.groups.manage', () => {
    renderCard(false);
    expect(screen.getByText('VIP')).toBeInTheDocument();
    expect(screen.getByText('Retired')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Change groups' })).not.toBeInTheDocument();
    // The catalogue is only fetched for the picker.
    expect(listGroups).not.toHaveBeenCalled();
  });

  it('offers live groups plus an archived one already carried, and saves the whole set in one call', async () => {
    const user = userEvent.setup();
    renderCard(true);
    await user.click(screen.getByRole('button', { name: 'Change groups' }));

    expect(await screen.findByRole('checkbox', { name: /Press/ })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: /VIP/ })).toBeChecked();
    // Carried and archived: listed, checked, and unchecking it is the way out.
    expect(screen.getByRole('checkbox', { name: /Retired/ })).toBeChecked();
    // Archived and not carried: not on offer.
    expect(screen.queryByRole('checkbox', { name: /Long gone/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole('checkbox', { name: /Press/ }));
    await user.click(screen.getByRole('checkbox', { name: /Retired/ }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(setCustomerGroups).toHaveBeenCalledTimes(1));
    expect(setCustomerGroups).toHaveBeenCalledWith(7, [1, 3]);
  });

  it('puts the selection back on cancel', async () => {
    const user = userEvent.setup();
    renderCard(true);
    await user.click(screen.getByRole('button', { name: 'Change groups' }));
    await user.click(await screen.findByRole('checkbox', { name: /Press/ }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(setCustomerGroups).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Change groups' }));
    expect(await screen.findByRole('checkbox', { name: /Press/ })).not.toBeChecked();
  });
});
