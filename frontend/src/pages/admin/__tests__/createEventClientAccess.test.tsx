/**
 * Client Access has to be set up while the event is being created.
 *
 * The controls were already on this page and already in the POST payload, but
 * they sat with no heading of their own, between "Default Photo Sort" and the
 * user-upload toggle. Reported from the field as simply absent: "hiện không
 * có, tôi phải xong rồi bấm edit mới thấy mục Client Access". Present but
 * unfindable is the same thing as missing, so what this pins is the heading
 * and the PIN field being reachable here, not just the payload.
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

const clientAccessToggle = () =>
  screen.getByText('clientAccess.enableToggle').closest('label')!.querySelector('input')!;

beforeEach(() => {
  createEvent.mockReset();
  createEvent.mockImplementation(() => new Promise(() => {}));
});

describe('CreateEventPage — Client Access is set up here, not after the fact', () => {
  it('carries the same heading the event page uses, so the section is findable', () => {
    renderPage();
    expect(screen.getByText('clientAccess.adminTitle')).toBeInTheDocument();
  });

  it('reveals the PIN field and the note about the link only once it is switched on', () => {
    renderPage();

    expect(screen.queryByText('clientAccess.pinLabel')).toBeNull();
    expect(screen.queryByText('clientAccess.linkAfterCreate')).toBeNull();

    fireEvent.click(clientAccessToggle());

    expect(screen.getByText('clientAccess.pinLabel')).toBeInTheDocument();
    // The link only exists once client_share_token is minted with the event,
    // which is why this screen promises it rather than showing it.
    expect(screen.getByText('clientAccess.linkAfterCreate')).toBeInTheDocument();
  });

  it('sends the toggle and the PIN with the event it was set up on', async () => {
    renderPage();

    fireEvent.change(screen.getByPlaceholderText('events.eventNamePlaceholder'), {
      target: { value: 'ZZTEST client access' },
    });
    fireEvent.click(clientAccessToggle());
    fireEvent.change(screen.getByPlaceholderText('clientAccess.pinPlaceholder'), {
      target: { value: '482193' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'events.createEvent' }));

    await waitFor(() => expect(createEvent).toHaveBeenCalledTimes(1));
    expect(createEvent.mock.calls[0][0]).toMatchObject({
      client_access_enabled: true,
      client_password: '482193',
    });
  });

  it('drops a PIN typed before the toggle was switched back off', async () => {
    renderPage();

    fireEvent.change(screen.getByPlaceholderText('events.eventNamePlaceholder'), {
      target: { value: 'ZZTEST client access off' },
    });
    fireEvent.click(clientAccessToggle());
    fireEvent.change(screen.getByPlaceholderText('clientAccess.pinPlaceholder'), {
      target: { value: '482193' },
    });
    fireEvent.click(clientAccessToggle());
    fireEvent.click(screen.getByRole('button', { name: 'events.createEvent' }));

    await waitFor(() => expect(createEvent).toHaveBeenCalledTimes(1));
    expect(createEvent.mock.calls[0][0]).toMatchObject({ client_access_enabled: false });
    expect(createEvent.mock.calls[0][0].client_password).toBeUndefined();
  });
});
