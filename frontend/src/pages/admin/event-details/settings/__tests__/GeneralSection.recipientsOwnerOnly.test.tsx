/**
 * Settings → General: who receives the gallery email is the owner's (the
 * server refuses a team member's change with 403). A team member sees the
 * customer address and the customer accounts read-only, with a hint; the
 * owner, and an older payload without the owner flag, edit them.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { GeneralSection } from '../sections';
import { eventFieldsFromEvent } from '../draft';
import type { Event } from '../../../../../types';

vi.mock('../../../../../hooks/usePermission', () => ({ usePermission: () => true }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key),
    i18n: { language: 'en' },
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));
vi.mock('../../../../../components/admin/CustomerAccountPicker', () => ({
  CustomerAccountPicker: ({ disabled }: { disabled?: boolean }) => <input aria-label="customer accounts" disabled={disabled} />,
}));
vi.mock('../../../../../components/admin/TeamMemberPicker', () => ({
  TeamMemberPicker: () => null,
}));

const HINT = 'Only the gallery owner can change who receives the gallery email.';

const renderAs = (canManage: boolean | undefined) => {
  const event = { id: 1, event_name: 'G', customer_email: 'client@example.com', can_manage_assignments: canManage } as unknown as Event;
  render(<GeneralSection f={eventFieldsFromEvent(event, null)} set={() => undefined} phoneFieldEnabled={false} event={event} />);
};

describe('GeneralSection — recipients are owner-only', () => {
  it('shows the customer address and accounts read-only to a team member', () => {
    renderAs(false);
    expect(screen.getByLabelText('events.hostEmail')).toBeDisabled();
    expect(screen.getByLabelText('events.hostEmail')).toHaveValue('client@example.com');
    expect(screen.getByLabelText('customer accounts')).toBeDisabled();
    expect(screen.getByText(HINT)).toBeInTheDocument();
  });

  it.each([true, undefined])('lets the owner edit them (can_manage_assignments %s)', (canManage) => {
    renderAs(canManage);
    expect(screen.getByLabelText('events.hostEmail')).toBeEnabled();
    expect(screen.getByLabelText('customer accounts')).toBeEnabled();
    expect(screen.queryByText(HINT)).not.toBeInTheDocument();
  });
});
