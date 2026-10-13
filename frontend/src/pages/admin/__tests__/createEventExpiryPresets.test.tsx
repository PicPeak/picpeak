/**
 * Create gallery: quick picks next to the "days after event date" field
 * (issue 1733). A pick sets the days, the matching pick shows as chosen, and
 * the number field stays for any other value. No "Never" here: with
 * expiration required the create route always computes an expiry.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../../../hooks/usePermission', () => ({ usePermission: () => true, useAnyPermission: () => true }));
vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({
      t: (k: string, fb?: unknown, opts?: { days?: number }) =>
        (typeof fb === 'string' ? fb.replace('{{days}}', String(opts?.days)) : k),
      i18n: { language: 'en' },
    }),
  };
});

vi.mock('react-toastify', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const createEvent = vi.fn();
vi.mock('../../../services/events.service', () => ({
  eventsService: { createEvent: (...args: unknown[]) => createEvent(...args) },
}));

vi.mock('../../../services/categories.service', () => ({
  categoriesService: { getCategories: vi.fn(async () => []) },
}));
vi.mock('../../../services/settings.service', () => ({
  settingsService: { getAllSettings: vi.fn(async () => ({})) },
}));
vi.mock('../../../services/cssTemplates.service', () => ({
  cssTemplatesService: { getEnabledTemplates: vi.fn(async () => []) },
}));
vi.mock('../../../services/eventTypes.service', () => ({
  eventTypesService: { getEventTypes: vi.fn(async () => []) },
}));
vi.mock('../../../services/userManagement.service', () => ({
  userManagementService: { getUsers: vi.fn(async () => []) },
}));

vi.mock('../../../hooks/usePublicSettings', () => ({
  PUBLIC_SETTINGS_QUERY_KEY: ['public-settings'],
  usePublicSettings: () => ({
    data: {
      event_require_customer_name: false,
      event_require_customer_email: false,
      event_require_admin_email: false,
      event_require_event_date: false,
      event_require_expiration: true,
      event_default_require_password: false,
    },
  }),
}));

vi.mock('../../../contexts/AdminAuthContext', () => ({ useAdminAuth: () => ({ user: null }) }));
vi.mock('../../../contexts/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({ flags: {}, isLoading: false }),
  useFeatureEnabled: () => false,
}));

vi.mock('../../../components/admin', async () => {
  const actual = await vi.importActual<any>('../../../components/admin');
  return {
    ...actual,
    ThemeCustomizerEnhanced: () => null,
    GalleryPreview: () => null,
    WelcomeMessageEditor: () => null,
    FeedbackSettings: () => null,
  };
});
vi.mock('../../../components/admin/CustomerAccountPicker', () => ({
  CustomerAccountPicker: () => null,
}));

import { CreateEventPage } from '../CreateEventPage';

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <CreateEventPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

const picks = () => within(screen.getByRole('group', { name: 'Expiry quick picks' }));
const pressed = () => picks().getAllByRole('button').filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.textContent);
// The number field the picks belong to (the form has other number fields).
const daysInput = () => screen.getByText('events.galleryExpiration').parentElement!
  .querySelector('input[type="number"]') as HTMLInputElement;

beforeEach(() => {
  createEvent.mockReset();
  createEvent.mockImplementation(() => new Promise(() => {}));
});

describe('CreateEventPage — expiry quick picks', () => {
  it('sets the days, shows the pick as chosen and sends it', async () => {
    renderPage();
    // The form starts at 30 days.
    expect(pressed()).toEqual(['30 days']);

    fireEvent.click(picks().getByRole('button', { name: '90 days' }));
    expect(daysInput().value).toBe('90');
    expect(pressed()).toEqual(['90 days']);

    fireEvent.change(screen.getByPlaceholderText('events.eventNamePlaceholder'), { target: { value: 'ZZTEST presets' } });
    fireEvent.click(screen.getByRole('button', { name: 'events.createEvent' }));
    await waitFor(() => expect(createEvent).toHaveBeenCalledTimes(1));
    expect(createEvent.mock.calls[0][0]).toMatchObject({ expiration_days: 90 });
  });

  it('keeps the free field: a value that is no pick leaves none chosen', () => {
    renderPage();
    fireEvent.change(daysInput(), { target: { value: '45' } });
    expect(pressed()).toEqual([]);
    expect(picks().queryByRole('button', { name: 'Never' })).toBeNull();
  });
});
