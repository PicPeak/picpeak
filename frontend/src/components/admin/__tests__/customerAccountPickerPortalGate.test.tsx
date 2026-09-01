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
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

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

vi.mock('../../../services/customerAdmin.service', () => ({
  customerAdminService: { search: vi.fn().mockResolvedValue([]) },
}));

import { CustomerAccountPicker } from '../CustomerAccountPicker';

const SEARCH_PLACEHOLDER = 'Search by email, name, or company';
const PORTAL_LABEL = 'Customer accounts';

describe('CustomerAccountPicker portal gate (QA S10)', () => {
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
});
