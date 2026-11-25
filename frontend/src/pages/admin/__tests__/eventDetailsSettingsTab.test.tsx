/**
 * The gallery's Settings tab behaves like the admin Settings pages: one
 * draft, one Save bar, only changed fields saved, and read-only sections for
 * a role that may not change them.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
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

const getEvent = vi.fn();
const updateEvent = vi.fn();
vi.mock('../../../services/events.service', () => ({
  eventsService: {
    getEvent: (...args: unknown[]) => getEvent(...args),
    getEventCategories: vi.fn().mockResolvedValue([]),
    updateEvent: (...args: unknown[]) => updateEvent(...args),
    deleteEvent: vi.fn(),
    extendExpiration: vi.fn(),
    duplicateEvent: vi.fn(),
    resetPassword: vi.fn(),
    publishEvent: vi.fn(),
    renameEvent: vi.fn(),
    revealNow: vi.fn(),
    archiveEvent: vi.fn(),
    sendGalleryEmail: vi.fn(),
  },
}));

const getEventPhotos = vi.fn();
vi.mock('../../../services/photos.service', () => ({
  CREDIT_FILTER_NONE: '__none__',
  photosService: {
    getEventPhotos: (...args: unknown[]) => getEventPhotos(...args),
    getFilterSummary: vi.fn().mockResolvedValue({}),
    getPhotoCredits: vi.fn().mockResolvedValue({ credits: [], none: 0 }),
  },
}));

vi.mock('../../../services/feedback.service', () => ({
  feedbackService: {
    getEventFeedbackSettings: vi.fn().mockResolvedValue({ identity_mode: 'simple' }),
  },
}));

vi.mock('../../../services/cssTemplates.service', () => ({
  cssTemplatesService: { getEnabledTemplates: vi.fn().mockResolvedValue([]) },
}));

vi.mock('../../../hooks/usePublicSettings', () => ({
  PUBLIC_SETTINGS_QUERY_KEY: ['public-settings'],
  usePublicSettings: () => ({ data: {} }),
}));

vi.mock('../../../contexts/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({ flags: {}, isLoading: false }),
  useFeatureEnabled: () => false,
}));

// The Settings draft reads the download-resolution overrides directly.
vi.mock('../../../config/api', () => ({
  api: { get: vi.fn().mockResolvedValue({ data: undefined }), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

let mockPerms: string[] = [];
vi.mock('../../../contexts/PermissionsContext', () => ({
  usePermissions: () => ({
    hasPermission: (p: string) => mockPerms.includes(p),
    hasAnyPermission: (ps: string[]) => ps.some((p) => mockPerms.includes(p)),
    isLoading: false,
  }),
}));

import { EventDetailsPage } from '../EventDetailsPage';
import { ConfirmDialogProvider } from '../../../components/common/ConfirmDialog';
import { UnsavedChangesProvider } from '../../../contexts/UnsavedChangesContext';

const EVENT = {
  id: 1,
  event_name: 'ZZTEST',
  slug: 'zztest',
  event_type: 'wedding',
  event_date: '2026-09-01T00:00:00.000Z',
  expires_at: '2027-09-01T00:00:00.000Z',
  is_active: true,
  is_archived: false,
  photo_count: 3,
  source_mode: 'managed',
  welcome_message: 'Hello',
  require_password: true,
};

function renderPage(entry: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ConfirmDialogProvider>
        <UnsavedChangesProvider>
          <MemoryRouter initialEntries={[entry]}>
            <Routes>
              <Route path="/admin/events/:id" element={<EventDetailsPage />} />
            </Routes>
          </MemoryRouter>
        </UnsavedChangesProvider>
      </ConfirmDialogProvider>
    </QueryClientProvider>
  );
}

describe('EventDetailsPage settings tab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getEvent.mockResolvedValue(EVENT);
    getEventPhotos.mockResolvedValue([]);
    updateEvent.mockResolvedValue({});
  });

  it('saves only what changed, through the one save bar', async () => {
    mockPerms = ['events.view', 'events.edit'];
    renderPage('/admin/events/1?tab=settings&section=general');

    const welcome = await screen.findByLabelText('events.welcomeMessageLabel');
    const save = screen.getByRole('button', { name: 'Save changes' });
    expect(save).toBeDisabled();

    fireEvent.change(welcome, { target: { value: 'Welcome!' } });
    await waitFor(() => expect(save).not.toBeDisabled());
    fireEvent.click(save);

    await waitFor(() => expect(updateEvent).toHaveBeenCalledTimes(1));
    expect(updateEvent).toHaveBeenCalledWith(1, { welcome_message: 'Welcome!' });
  });

  it('shows the settings read-only to a role without events.edit', async () => {
    mockPerms = ['events.view', 'events.support'];
    renderPage('/admin/events/1?tab=settings&section=general');

    const welcome = await screen.findByLabelText('events.welcomeMessageLabel');
    expect(welcome).toBeDisabled();
    expect(screen.getByText('You can see these settings but not change them.')).toBeInTheDocument();
  });
});
