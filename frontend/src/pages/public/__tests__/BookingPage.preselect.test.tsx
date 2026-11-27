/**
 * The website's booking button can name a service (issue 2618): the booking
 * page opens with it chosen, and ignores a name it does not offer.
 */
import React from 'react';
import { expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, fb?: unknown) => (typeof fb === 'string' ? fb : k), i18n: { language: 'en', changeLanguage: vi.fn() } }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));
vi.mock('../../../hooks/usePublicDarkMode', () => ({ usePublicDarkMode: () => ({ isDark: false }) }));
vi.mock('../../../hooks/usePublicSettings', () => ({ usePublicSettings: () => ({ data: {} }) }));
vi.mock('../../../services/booking.service', () => {
  const service = (id: number, name: string) => ({ id, name, description: null, currency: 'CHF', durationMinutes: 60, durationFactorId: null, factors: [], deposit: null });
  return {
  bookingService: {
    publicInfo: vi.fn().mockResolvedValue({
      businessName: 'Studio', defaultLanguage: 'en', intro: null, timezone: 'Europe/Zurich', formToken: 't',
      leadTimeHours: 24, horizonDays: 60, services: [service(1, 'Portraits'), service(2, 'Weddings')],
    }),
    estimate: vi.fn().mockResolvedValue({ currency: 'CHF', totalMinor: 0, lines: [] }),
    slots: vi.fn().mockResolvedValue({ slots: [] }),
  },
  };
});

import { BookingPage } from '../BookingPage';

const open = (url: string) => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter initialEntries={[url]}><BookingPage /></MemoryRouter>
  </QueryClientProvider>,
);

it('opens with the service the link names', async () => {
  open('/book?service=2');
  expect(await screen.findByRole('radio', { name: /Weddings/ })).toBeChecked();
  expect(screen.getByRole('radio', { name: /Portraits/ })).not.toBeChecked();
});

it('ignores a service it does not offer', async () => {
  open('/book?service=99');
  expect(await screen.findByRole('radio', { name: /Weddings/ })).not.toBeChecked();
  expect(screen.getByRole('radio', { name: /Portraits/ })).not.toBeChecked();
});
