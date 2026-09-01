/**
 * The Accounting "bill this to a client" modals reuse CustomerAccountPicker,
 * which used to hide itself whenever `customerPortal` was off — the default.
 * The required field then rendered as a lone label with no input and the
 * submit button could never enable (QA S10).
 *
 * Accounting/customerPortal is a supported flag combination: /admin/customers
 * and /admin/customers/search are permission-gated, not flag-gated, and
 * POST /admin/customers creates passive (portal-less) customers on purpose.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({ t: (k: string, fb?: unknown) => (typeof fb === 'string' ? fb : k) }),
  };
});

let portalEnabled = false;
vi.mock('../../../contexts/FeatureFlagsContext', () => ({
  useFeatureEnabled: () => portalEnabled,
}));

let canCreate = true;
vi.mock('../../../hooks/usePermission', () => ({
  usePermission: () => canCreate,
}));

// The inline create form is exercised by its own suites; stub it here so this
// file keeps testing only the gate + the create affordance.
vi.mock('../InlineCustomerCreate', () => ({
  InlineCustomerCreate: ({ mode }: { mode?: string }) => (
    <div data-testid="inline-create">{mode}</div>
  ),
}));

vi.mock('../../../services/customerAdmin.service', () => ({
  customerAdminService: { search: vi.fn().mockResolvedValue([]) },
}));

import { CustomerAccountPicker } from '../CustomerAccountPicker';

const SEARCH_PLACEHOLDER = 'Search by email, name, or company';
const PORTAL_LABEL = 'Customer accounts';
const CREATE_LINK = '+ Create new customer';

describe('CustomerAccountPicker portal gate (QA S10)', () => {
  beforeEach(() => { canCreate = true; });

  it('renders a usable search input with customerPortal off when portalAssignment=false', () => {
    portalEnabled = false;
    render(<CustomerAccountPicker portalAssignment={false} value={[]} onChange={() => {}} />);

    expect(screen.getByPlaceholderText(SEARCH_PLACEHOLDER)).toBeInTheDocument();
    // The caller renders its own field label ("Client *"), so the portal
    // label + gallery-password help text stay out of the way.
    expect(screen.queryByText(PORTAL_LABEL)).not.toBeInTheDocument();
  });

  it('still hides itself entirely on the event form when customerPortal is off', () => {
    portalEnabled = false;
    const { container } = render(<CustomerAccountPicker value={[]} onChange={() => {}} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('keeps the portal label + help text on the event form when customerPortal is on', () => {
    portalEnabled = true;
    render(<CustomerAccountPicker value={[]} onChange={() => {}} />);

    expect(screen.getByText(PORTAL_LABEL)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(SEARCH_PLACEHOLDER)).toBeInTheDocument();
  });

  // B12 — on an Accounting-only install /admin/clients/accounts and every CRM
  // editor that embeds InlineCustomerCreate are feature-gated, so the picker is
  // the only place left that can reach POST /admin/customers.
  it('offers inline create (passive-only) when the portal is off', () => {
    portalEnabled = false;
    render(<CustomerAccountPicker portalAssignment={false} value={[]} onChange={() => {}} />);

    fireEvent.click(screen.getByText(CREATE_LINK));
    expect(screen.getByTestId('inline-create')).toHaveTextContent('passive');
  });

  it('offers both save modes when the portal is on', () => {
    portalEnabled = true;
    render(<CustomerAccountPicker value={[]} onChange={() => {}} />);

    fireEvent.click(screen.getByText(CREATE_LINK));
    expect(screen.getByTestId('inline-create')).toHaveTextContent('both');
  });

  it('hides the create affordance without customers.create', () => {
    portalEnabled = false;
    canCreate = false;
    render(<CustomerAccountPicker portalAssignment={false} value={[]} onChange={() => {}} />);

    expect(screen.queryByText(CREATE_LINK)).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText(SEARCH_PLACEHOLDER)).toBeInTheDocument();
  });
});
