/**
 * Workflow editor → the customer_in_group condition (#1443): offered in the
 * condition list, picks live groups into `groupIds`, sets any/all, and says
 * so rather than showing an empty list when the admin can't read groups.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return { ...actual, useTranslation: () => ({ t: (k: string, fb?: unknown) => (typeof fb === 'string' ? fb : k) }) };
});

const listGroups = vi.fn();
vi.mock('../../../../services/customerAdmin.service', () => ({
  customerAdminService: { listGroups: (...a: unknown[]) => listGroups(...a) },
}));

import { PermissionsContext } from '../../../../contexts/PermissionsContext';
import { NodeConfigPanel } from '../NodeConfigPanel';

const renderPanel = (config: Record<string, unknown>, onChange = vi.fn(), permissions = ['customers.view']) => {
  const ctx = { hasPermission: (p: string) => permissions.includes(p) };
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <PermissionsContext.Provider value={ctx as never}>
        <NodeConfigPanel nodeType="condition" config={config} onChange={onChange} />
      </PermissionsContext.Provider>
    </QueryClientProvider>,
  );
  return onChange;
};

beforeEach(() => {
  vi.clearAllMocks();
  listGroups.mockResolvedValue([
    { id: 1, name: 'VIP', description: null, color: '#2563EB', sortOrder: 1, isArchived: false },
    { id: 2, name: 'Retired', description: null, color: '#4B5563', sortOrder: 2, isArchived: true },
  ]);
});

describe('customer_in_group condition', () => {
  it('is offered in the condition list', () => {
    renderPanel({ condition: 'expr' });
    expect(screen.getByRole('option', { name: 'Customer is in group' })).toBeInTheDocument();
    expect(listGroups).not.toHaveBeenCalled();
  });

  it('picks live groups into groupIds and sets the match', async () => {
    const user = userEvent.setup();
    const onChange = renderPanel({ condition: 'customer_in_group', groupIds: [] });
    await user.click(await screen.findByRole('checkbox', { name: 'VIP' }));
    expect(onChange).toHaveBeenLastCalledWith({ condition: 'customer_in_group', groupIds: [1] });
    expect(screen.queryByRole('checkbox', { name: 'Retired' })).toBeNull();

    await user.selectOptions(screen.getByDisplayValue('Any of them'), 'all');
    expect(onChange).toHaveBeenLastCalledWith({ condition: 'customer_in_group', groupIds: [], match: 'all' });
  });

  it('explains instead of listing without customers.view', () => {
    renderPanel({ condition: 'customer_in_group', groupIds: [1] }, vi.fn(), []);
    expect(screen.getByText(/needs the customers.view permission/)).toBeInTheDocument();
    expect(listGroups).not.toHaveBeenCalled();
  });
});
