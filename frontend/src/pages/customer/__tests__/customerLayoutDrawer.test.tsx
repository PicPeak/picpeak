/**
 * Customer portal sidebar below `lg`: an off-screen drawer. Closed, it was
 * only translated away, so its links stayed in the tab order; open, focus
 * stayed on the menu button and Tab walked the page behind the backdrop.
 * From `lg` up the sidebar is always on screen and must stay reachable.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

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
vi.mock('../../../hooks/usePublicSettings', () => ({
  usePublicSettings: () => ({ data: { branding_company_name: 'Studio Nord' } }),
}));
vi.mock('../../../hooks/usePublicDarkMode', () => ({
  usePublicDarkMode: () => ({ isDark: false }),
}));
vi.mock('../../../contexts/CustomerAuthContext', () => ({
  useCustomerAuth: () => ({
    customer: { email: 'kim@example.com' },
    features: {},
    branding: { showLogo: false, showCompanyName: true },
    isAuthenticated: true,
    isLoading: false,
    logout: vi.fn(),
  }),
}));

import { CustomerLayout } from '../CustomerLayout';

const stubViewport = (drawer: boolean) => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: drawer,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
};

const renderLayout = () => render(
  <MemoryRouter initialEntries={['/customer/dashboard']}>
    <Routes>
      <Route path="/customer" element={<CustomerLayout />}>
        <Route path="dashboard" element={<button>page action</button>} />
      </Route>
    </Routes>
  </MemoryRouter>,
);

const aside = (container: HTMLElement) => container.querySelector('aside') as HTMLElement;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('CustomerLayout drawer below lg', () => {
  it('is inert while closed and reachable while open', async () => {
    stubViewport(true);
    const user = userEvent.setup();
    const { container } = renderLayout();
    expect(aside(container)).toHaveAttribute('inert');

    await user.click(screen.getByRole('button', { name: 'Menu' }));
    expect(aside(container)).not.toHaveAttribute('inert');
  });

  it('moves focus to the close button on open and wraps Tab inside', async () => {
    stubViewport(true);
    const user = userEvent.setup();
    renderLayout();
    screen.getByRole('button', { name: 'Menu' }).focus();
    await user.keyboard('{Enter}');

    const close = screen.getByRole('button', { name: 'Close' });
    expect(close).toHaveFocus();

    const logout = screen.getByRole('button', { name: 'Logout' });
    logout.focus();
    await user.tab();
    expect(screen.getByRole('link', { name: 'Studio Nord' })).toHaveFocus();
  });

  it('returns focus to the menu button on Escape', async () => {
    stubViewport(true);
    const user = userEvent.setup();
    const { container } = renderLayout();
    screen.getByRole('button', { name: 'Menu' }).focus();
    await user.keyboard('{Enter}');
    await user.keyboard('{Escape}');

    expect(aside(container)).toHaveAttribute('inert');
    expect(screen.getByRole('button', { name: 'Menu' })).toHaveFocus();
  });
});

describe('CustomerLayout from lg up', () => {
  it('leaves the always-visible sidebar reachable', () => {
    stubViewport(false);
    const { container } = renderLayout();
    expect(aside(container)).not.toHaveAttribute('inert');
  });
});
