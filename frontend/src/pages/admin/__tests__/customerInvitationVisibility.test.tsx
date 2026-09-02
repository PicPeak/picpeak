/**
 * "Invite customer" is two calls: createDirect, then sendInvite. When the
 * second one doesn't land, what's left behind is a passive customer — and the
 * customers table rendered that identically to one the admin created as
 * passive on purpose. Both showed "Passive — admin only", so the row could not
 * answer the only question the admin had: did the invitation go out? (#1261)
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({
      t: (k: string, fb?: unknown) => (typeof fb === 'string' ? fb : k),
      i18n: { language: 'en' },
    }),
  };
});

vi.mock('react-toastify', () => ({
  toast: { success: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
import { toast } from 'react-toastify';
const toastSuccess = toast.success as ReturnType<typeof vi.fn>;
const toastWarn = toast.warn as ReturnType<typeof vi.fn>;

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
const listInvitations = vi.fn();
const createDirect = vi.fn();
const sendInvite = vi.fn();
vi.mock('../../../services/customerAdmin.service', () => ({
  customerAdminService: {
    list: (...a: unknown[]) => list(...a),
    listInvitations: (...a: unknown[]) => listInvitations(...a),
    createDirect: (...a: unknown[]) => createDirect(...a),
    sendInvite: (...a: unknown[]) => sendInvite(...a),
    deactivate: vi.fn(),
    cancelInvitation: vi.fn(),
  },
}));

vi.mock('../../../services/businessProfile.service', () => ({
  businessProfileService: { get: vi.fn().mockResolvedValue({ profile: {} }) },
}));

import { CustomerManagementPage } from '../CustomerManagementPage';
import { InlineCustomerCreate } from '../../../components/admin/InlineCustomerCreate';

const customer = (id: number, email: string, extra: Record<string, unknown> = {}) => ({
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
  ...extra,
});

const invitation = (id: number, email: string) => ({
  id,
  email,
  expiresAt: '2026-12-01T00:00:00.000Z',
  createdAt: '2026-09-01T00:00:00.000Z',
  invitedBy: 'admin',
});

function renderWith(node: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  listInvitations.mockResolvedValue([]);
  list.mockResolvedValue([]);
});

describe('CustomerManagementPage — invited vs merely passive (#1261)', () => {
  it('marks a passive customer who has an open invitation', async () => {
    list.mockResolvedValue([customer(1, 'invited@example.com')]);
    listInvitations.mockResolvedValue([invitation(9, 'invited@example.com')]);

    renderWith(<CustomerManagementPage />);

    expect(await screen.findByText('Invitation pending')).toBeTruthy();
    expect(screen.queryByText('Passive — admin only')).toBeNull();
  });

  it('leaves a passive customer with no invitation reading as passive', async () => {
    list.mockResolvedValue([customer(2, 'nobody@example.com')]);
    listInvitations.mockResolvedValue([]);

    renderWith(<CustomerManagementPage />);

    expect(await screen.findByText('Passive — admin only')).toBeTruthy();
    expect(screen.queryByText('Invitation pending')).toBeNull();
  });

  it('matches the invitation regardless of address casing', async () => {
    // customer_invitations stores the address lowercased; customer_accounts
    // preserves what the admin typed. A case-sensitive match would show every
    // mixed-case customer as never invited.
    list.mockResolvedValue([customer(3, 'Mixed.Case@Example.com')]);
    listInvitations.mockResolvedValue([invitation(11, 'mixed.case@example.com')]);

    renderWith(<CustomerManagementPage />);

    expect(await screen.findByText('Invitation pending')).toBeTruthy();
  });

  it('does not mark an active customer, who needs no invitation', async () => {
    list.mockResolvedValue([customer(4, 'active@example.com', { isPassive: false })]);
    listInvitations.mockResolvedValue([invitation(12, 'active@example.com')]);

    renderWith(<CustomerManagementPage />);

    await screen.findByText('Customer 4');
    expect(screen.queryByText('Invitation pending')).toBeNull();
  });
});

describe('InlineCustomerCreate — what the toast may claim (#1261)', () => {
  const fill = async () => {
    await userEvent.type(screen.getByPlaceholderText('name@example.com'), 'new@example.com');
    await userEvent.type(screen.getByLabelText(/Company name/i), 'Acme');
  };

  it('says queued, not sent — this code cannot know it was delivered', async () => {
    createDirect.mockResolvedValue({ id: 5, email: 'new@example.com' });
    sendInvite.mockResolvedValue({ id: 1, email: 'new@example.com', expiresAt: 'x' });

    renderWith(<InlineCustomerCreate mode="invite" onCreated={() => {}} onCancel={() => {}} />);
    await fill();
    await userEvent.click(screen.getByRole('button', { name: /Save & send portal invitation/i }));

    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    const message = String(toastSuccess.mock.calls[0][0]);
    expect(message).toMatch(/queued/i);
    expect(message).not.toMatch(/invitation sent/i);
  });

  it('says the customer is PASSIVE when the invitation call failed', async () => {
    createDirect.mockResolvedValue({ id: 6, email: 'new@example.com' });
    sendInvite.mockRejectedValue({ response: { status: 500 } });

    renderWith(<InlineCustomerCreate mode="invite" onCreated={() => {}} onCancel={() => {}} />);
    await fill();
    await userEvent.click(screen.getByRole('button', { name: /Save & send portal invitation/i }));

    await waitFor(() => expect(toastWarn).toHaveBeenCalled());
    expect(String(toastWarn.mock.calls[0][0])).toMatch(/PASSIVE/);
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it('distinguishes a 409 — the customer IS invited, the re-invite was refused', async () => {
    createDirect.mockResolvedValue({ id: 7, email: 'new@example.com' });
    sendInvite.mockRejectedValue({ response: { status: 409 } });

    renderWith(<InlineCustomerCreate mode="invite" onCreated={() => {}} onCancel={() => {}} />);
    await fill();
    await userEvent.click(screen.getByRole('button', { name: /Save & send portal invitation/i }));

    await waitFor(() => expect(toastWarn).toHaveBeenCalled());
    const message = String(toastWarn.mock.calls[0][0]);
    expect(message).toMatch(/already open/i);
    expect(message).not.toMatch(/PASSIVE/);
  });
});
