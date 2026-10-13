/**
 * A draft does not follow the admin to another gallery (issue 1733, fork
 * survey). /admin/events/1 and /admin/events/2 are the same route element,
 * so the page stays mounted across the navigation; with gallery 2 already in
 * the query cache nothing unmounts the Settings draft on the way.
 *
 * Pins:
 *  - leaving a dirty gallery for another gallery asks
 *  - "Stay" keeps the gallery and its draft
 *  - "Discard and leave" opens the other gallery with ITS values: nothing
 *    of the first gallery's draft is shown, or offered for saving
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router-dom';
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
    getExportFormats: vi.fn().mockResolvedValue([]),
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

const mockPerms = ['events.view', 'events.edit'];
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


const OTHER = { ...EVENT, id: 2, event_name: 'ZZOTHER', slug: 'zzother', welcome_message: 'Second gallery' };

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  // Both galleries are cached, as after visiting each once: no loading state
  // in between that would unmount the page's children.
  qc.setQueryData(['admin-event', '1'], EVENT);
  qc.setQueryData(['admin-event', '2'], OTHER);
  const router = createMemoryRouter(
    [{
      element: <UnsavedChangesProvider><Outlet /></UnsavedChangesProvider>,
      children: [{ path: '/admin/events/:id', element: <EventDetailsPage /> }],
    }],
    { initialEntries: ['/admin/events/1?tab=settings&section=general'] },
  );
  render(
    <QueryClientProvider client={qc}>
      <ConfirmDialogProvider>
        <RouterProvider router={router} />
      </ConfirmDialogProvider>
    </QueryClientProvider>
  );
  return router;
}

describe('EventDetailsPage: a draft stays with its gallery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getEvent.mockImplementation(async (id: number) => (id === 2 ? OTHER : EVENT));
    getEventPhotos.mockResolvedValue([]);
    updateEvent.mockResolvedValue({});
  });

  it('asks before opening another gallery, and does not carry the draft over', async () => {
    const router = renderPage();
    const other = '/admin/events/2?tab=settings&section=general';

    fireEvent.change(await screen.findByLabelText('events.welcomeMessageLabel'), { target: { value: 'Draft for gallery one' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save changes' })).not.toBeDisabled());

    // Stay: same gallery, draft intact.
    await act(() => router.navigate(other));
    fireEvent.click(await screen.findByRole('button', { name: 'Stay' }));
    await waitFor(() => expect(screen.queryByText('Discard unsaved changes?')).not.toBeInTheDocument());
    expect(router.state.location.pathname).toBe('/admin/events/1');
    expect(screen.getByLabelText('events.welcomeMessageLabel')).toHaveValue('Draft for gallery one');

    // Leave: the other gallery, with its own values and nothing to save.
    await act(() => router.navigate(other));
    fireEvent.click(await screen.findByRole('button', { name: 'Discard and leave' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/events/2'));
    await waitFor(() => expect(screen.getByLabelText('events.welcomeMessageLabel')).toHaveValue('Second gallery'));
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    expect(updateEvent).not.toHaveBeenCalled();
  });
});
