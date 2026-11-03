/**
 * A login at several companies works in one at a time. The switcher shows only
 * then, and a switch replaces the whole session, not just a label.
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const { setSession, switchCompany, auth } = vi.hoisted(() => ({
  setSession: vi.fn(),
  switchCompany: vi.fn(),
  auth: { customer: null as unknown },
}));

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key),
      i18n: { language: 'en' },
    }),
  };
});
vi.mock('react-toastify', () => ({ toast: { error: vi.fn() } }));
vi.mock('../../../hooks/usePublicSettings', () => ({
  usePublicSettings: () => ({ data: { branding_company_name: 'Studio Nord' } }),
}));
vi.mock('../../../hooks/usePublicDarkMode', () => ({ usePublicDarkMode: () => ({ isDark: false }) }));
vi.mock('../../../services/customer.service', () => ({ customerService: { switchCompany } }));
vi.mock('../../../contexts/CustomerAuthContext', () => ({
  useCustomerAuth: () => ({
    customer: auth.customer,
    features: {},
    branding: { showLogo: false, showCompanyName: true },
    isAuthenticated: true,
    isLoading: false,
    logout: vi.fn(),
    setSession,
  }),
}));

import { CustomerLayout } from '../CustomerLayout';

const renderLayout = () => render(
  <MemoryRouter initialEntries={['/customer/quotes']}>
    <Routes>
      <Route path="/customer" element={<CustomerLayout />}>
        <Route path="quotes" element={<p>quotes page</p>} />
        <Route path="dashboard" element={<p>dashboard page</p>} />
      </Route>
    </Routes>
  </MemoryRouter>,
);

describe('company switcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {},
    }));
  });

  it('is not there for a login at one company', () => {
    auth.customer = { id: 1, email: 'kim@example.com', companies: [{ id: 1, name: 'Firma XYZ' }] };
    renderLayout();
    expect(screen.queryByLabelText('Company')).toBeNull();
  });

  it('names a company the login may not see the name of by its id', () => {
    auth.customer = {
      id: 1,
      email: 'kim@example.com',
      companies: [{ id: 1, name: 'Firma XYZ' }, { id: 2, name: null }],
    };
    renderLayout();
    // The mocked t answers with the key when it gets options.
    expect(screen.getByRole('option', { name: 'customer.nav.companyById' })).toBeTruthy();
  });

  it('replaces the session and returns to the dashboard', async () => {
    auth.customer = {
      id: 1,
      email: 'kim@example.com',
      companies: [{ id: 1, name: 'Firma XYZ' }, { id: 2, name: 'Firma ABC' }],
    };
    const next = { customer: { id: 2 }, features: {}, branding: {} };
    switchCompany.mockResolvedValue(next);
    renderLayout();
    await userEvent.selectOptions(screen.getByLabelText('Company'), '2');
    await waitFor(() => expect(setSession).toHaveBeenCalledWith(next));
    expect(switchCompany).toHaveBeenCalledWith(2);
    expect(await screen.findByText('dashboard page')).toBeTruthy();
  });

  it('closes the phone menu after a switch', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: true, media: query, addEventListener: () => {}, removeEventListener: () => {},
    }));
    auth.customer = {
      id: 1,
      email: 'kim@example.com',
      companies: [{ id: 1, name: 'Firma XYZ' }, { id: 2, name: 'Firma ABC' }],
    };
    switchCompany.mockResolvedValue({ customer: { id: 2 }, features: {}, branding: {} });
    renderLayout();
    await userEvent.click(screen.getByRole('button', { name: /menu/i }));
    await userEvent.selectOptions(screen.getByLabelText('Company'), '2');
    expect(await screen.findByText('dashboard page')).toBeTruthy();
    await waitFor(() => expect(document.querySelector('aside')?.hasAttribute('inert')).toBe(true));
  });

  it('stays where it is when the switch fails', async () => {
    auth.customer = {
      id: 1,
      email: 'kim@example.com',
      companies: [{ id: 1, name: 'Firma XYZ' }, { id: 2, name: 'Firma ABC' }],
    };
    switchCompany.mockRejectedValue(new Error('no'));
    renderLayout();
    await userEvent.selectOptions(screen.getByLabelText('Company'), '2');
    await waitFor(() => expect(switchCompany).toHaveBeenCalled());
    expect(setSession).not.toHaveBeenCalled();
    expect(screen.getByText('quotes page')).toBeTruthy();
  });
});
