/**
 * Customer detail → Contacts card.
 *
 * The login follows an address change, so editing the address of a contact
 * who has one warns that the password goes with it.
 */
import { render, screen } from '@testing-library/react';
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

vi.mock('../../../hooks/useLocalizedDate', () => ({
  useLocalizedDate: () => ({ format: (d: string) => d }),
}));

const listContacts = vi.fn();
vi.mock('../../../services/customerAdmin.service', () => ({
  customerAdminService: {
    listContacts: (...a: unknown[]) => listContacts(...a),
  },
}));

import { ConfirmDialogProvider } from '../../common';
import { CustomerContactsCard } from '../CustomerContactsCard';

const contact = (id: number, email: string, hasLogin: boolean) => ({
  id, customerAccountId: 7, email, firstName: 'Mia', lastName: null, displayName: null,
  isActive: true, receivesMail: true, hasLogin, invitationPending: false, lastLogin: null,
  rights: { galleries: 'view', quotes: 'none', contracts: 'none', bills: 'none', documents: 'none', company: 'none' },
});

const WARNING = /The login and password move to the new address/;

const renderCard = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <ConfirmDialogProvider>
      <CustomerContactsCard customerId={7} isPassive={false} portalEnabled canCreate canEdit canDelete />
    </ConfirmDialogProvider>
  </QueryClientProvider>,
);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('CustomerContactsCard', () => {
  it('warns that the login moves when the address of a contact with a login changes', async () => {
    listContacts.mockResolvedValue([contact(1, 'mia@example.test', true)]);
    const user = userEvent.setup();
    renderCard();
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    const email = screen.getByLabelText('Email');
    expect(screen.queryByText(WARNING)).not.toBeInTheDocument();
    await user.clear(email);
    await user.type(email, 'MIA@example.test');
    expect(screen.queryByText(WARNING)).not.toBeInTheDocument();
    await user.clear(email);
    await user.type(email, 'tom@example.test');
    expect(screen.getByText(WARNING)).toBeInTheDocument();
  });

  it('does not warn for a contact without a login', async () => {
    listContacts.mockResolvedValue([contact(1, 'mia@example.test', false)]);
    const user = userEvent.setup();
    renderCard();
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    await user.clear(screen.getByLabelText('Email'));
    await user.type(screen.getByLabelText('Email'), 'tom@example.test');
    expect(screen.queryByText(WARNING)).not.toBeInTheDocument();
  });
});
