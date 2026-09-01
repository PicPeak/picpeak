/**
 * "Create event" could fire two real POSTs racing the same slug — one 500'd on
 * `events_slug_unique` (QA 7.03).
 *
 * The Button already carried `disabled={createMutation.isPending}`, which
 * covers the ordinary double-click. `handleSubmit` itself had no re-entrancy
 * guard though, so any submit that does not go through the button (implicit
 * form submission, a programmatic `requestSubmit`) still raced a second POST.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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

// Every "is this field required" flag off, so the only thing validateForm
// needs is the event name.
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

vi.mock('../../../contexts/AdminAuthContext', () => ({
  useAdminAuth: () => ({ user: null }),
}));

vi.mock('../../../contexts/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({ flags: {}, isLoading: false }),
  useFeatureEnabled: () => false,
}));

// Heavy children not involved in the submit path.
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

describe('CreateEventPage double-submit guard (QA 7.03)', () => {
  beforeEach(() => {
    createEvent.mockReset();
    // Never settles — keeps the mutation in flight for the whole test.
    createEvent.mockImplementation(() => new Promise(() => {}));
  });

  it('fires exactly one POST when the form is submitted twice in a row', async () => {
    renderPage();

    fireEvent.change(screen.getByPlaceholderText('events.eventNamePlaceholder'), {
      target: { value: 'ZZTEST double submit' },
    });

    const form = screen.getByRole('button', { name: 'events.createEvent' }).closest('form')!;
    fireEvent.submit(form);
    fireEvent.submit(form);

    await waitFor(() => expect(createEvent).toHaveBeenCalled());
    expect(createEvent).toHaveBeenCalledTimes(1);
  });

  it('disables the submit button while the request is in flight', async () => {
    renderPage();

    fireEvent.change(screen.getByPlaceholderText('events.eventNamePlaceholder'), {
      target: { value: 'ZZTEST in flight' },
    });

    const submit = screen.getByRole('button', { name: 'events.createEvent' }) as HTMLButtonElement;
    fireEvent.click(submit);

    expect(submit).toBeDisabled();
    await waitFor(() => expect(createEvent).toHaveBeenCalledTimes(1));
  });
});
