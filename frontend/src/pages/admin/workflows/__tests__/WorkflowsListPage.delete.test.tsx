/**
 * Workflows list → delete. The server refuses the delete to everyone but a
 * super admin, so the button is offered to a super admin only, and a refusal
 * that still comes back shows the server's own message.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return { ...actual, useTranslation: () => ({ t: (k: string, fb?: unknown) => (typeof fb === 'string' ? fb : k) }) };
});

const toastError = vi.fn();
vi.mock('react-toastify', () => ({
  toast: { error: (...a: unknown[]) => toastError(...a), success: vi.fn() },
}));

const list = vi.fn();
const remove = vi.fn();
vi.mock('../../../../services/workflows.service', () => ({
  workflowsService: {
    list: (...a: unknown[]) => list(...a),
    remove: (...a: unknown[]) => remove(...a),
  },
}));

import { PermissionsContext } from '../../../../contexts/PermissionsContext';
import { WorkflowsListPage } from '../WorkflowsListPage';

const renderPage = (isSuperAdmin: boolean) => {
  // A delegated manager holds workflows.manage either way.
  const ctx = { isSuperAdmin, hasPermission: () => true };
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <PermissionsContext.Provider value={ctx as never}>
        <MemoryRouter>
          <WorkflowsListPage />
        </MemoryRouter>
      </PermissionsContext.Provider>
    </QueryClientProvider>,
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  list.mockResolvedValue([
    { id: 7, name: 'Custom flow', enabled: false, version: 1, trigger_type: 'invoice.sent', is_builtin: false },
  ]);
});

describe('workflow delete', () => {
  it('is not offered to a workflow manager who is not a super admin', async () => {
    renderPage(false);
    expect(await screen.findByText('Custom flow')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });

  it('is offered to a super admin and shows the server message when refused', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    remove.mockRejectedValue({ response: { status: 403, data: { error: 'Only a super administrator can delete workflows' } } });
    renderPage(true);
    await userEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    expect(remove.mock.calls[0][0]).toBe(7);
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Only a super administrator can delete workflows'));
  });
});
