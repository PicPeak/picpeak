/**
 * "Finish selection" can be switched on while the gallery is being created.
 *
 * The create form renders the same <FeedbackSettings> card as the gallery's
 * settings, so the switch sits with likes and favorites and, as there, only
 * once feedback is enabled. Pinned here: it is reachable on this page, it is
 * off unless switched on, and its value travels in the create payload.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../../../hooks/usePermission', () => ({ usePermission: () => true, useAnyPermission: () => true }));
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
      event_require_expiration: false,
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

const toggle = (label: string) =>
  screen.getByText(label).closest('label')!.querySelector('input')!;

const submit = async (name: string) => {
  fireEvent.change(screen.getByPlaceholderText('events.eventNamePlaceholder'), {
    target: { value: name },
  });
  fireEvent.click(screen.getByRole('button', { name: 'events.createEvent' }));
  await waitFor(() => expect(createEvent).toHaveBeenCalledTimes(1));
  return createEvent.mock.calls[0][0];
};

beforeEach(() => {
  createEvent.mockReset();
  createEvent.mockImplementation(() => new Promise(() => {}));
});

describe('CreateEventPage: Finish selection', () => {
  it('offers the switch next to likes and favorites once feedback is enabled, unchecked', () => {
    renderPage();

    expect(screen.queryByText('Finish selection')).toBeNull();

    fireEvent.click(toggle('Enable feedback'));

    expect(screen.getByText('Likes')).toBeInTheDocument();
    expect(screen.getByText('Favorites')).toBeInTheDocument();
    expect(toggle('Finish selection').checked).toBe(false);
  });

  it('sends it switched on with the gallery it was set up on', async () => {
    renderPage();

    fireEvent.click(toggle('Enable feedback'));
    fireEvent.click(toggle('Finish selection'));

    expect(await submit('ZZTEST finish selection')).toMatchObject({
      feedback_enabled: true,
      allow_selection_submit: true,
    });
  });

  it('sends it off when it was never touched', async () => {
    renderPage();

    fireEvent.click(toggle('Enable feedback'));

    expect(await submit('ZZTEST finish selection off')).toMatchObject({
      feedback_enabled: true,
      allow_selection_submit: false,
    });
  });
});
