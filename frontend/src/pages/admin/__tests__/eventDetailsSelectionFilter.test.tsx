/**
 * The selection filter on the Photos tab (issue 2356) is offered only while
 * the event has a selection. Clearing the selection in Settings while "Only in
 * the full view" was chosen left that value in the photo query with no control
 * to undo it, so the grid stayed empty until a reload.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
vi.mock('../../../services/events.service', () => ({
  eventsService: {
    getEvent: (...args: unknown[]) => getEvent(...args),
    getEventCategories: vi.fn().mockResolvedValue([]),
    updateEvent: vi.fn(),
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

vi.mock('../../../contexts/PermissionsContext', () => ({
  usePermissions: () => ({ hasAnyPermission: () => true, hasPermission: () => true, isLoading: false }),
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
  source_mode: 'managed',
};

let qc: QueryClient;
function renderPage() {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ConfirmDialogProvider>
        <UnsavedChangesProvider>
          <MemoryRouter initialEntries={['/admin/events/1?tab=photos']}>
            <Routes>
              <Route path="/admin/events/:id" element={<EventDetailsPage />} />
            </Routes>
          </MemoryRouter>
        </UnsavedChangesProvider>
      </ConfirmDialogProvider>
    </QueryClientProvider>
  );
}

const selectionSelect = () => screen.queryByLabelText('Selection') as HTMLSelectElement | null;

describe('EventDetailsPage selection filter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getEventPhotos.mockResolvedValue([]);
  });

  it('drops the selection filter once the event no longer has a selection', async () => {
    getEvent.mockResolvedValue({ ...EVENT, source_mode: 'reference', external_path: 'shoot', selection_path: 'gallery', photo_count: 3, video_count: 0 });
    renderPage();
    await waitFor(() => expect(selectionSelect()).not.toBeNull());

    await userEvent.selectOptions(selectionSelect()!, 'out');
    await waitFor(() => {
      expect(getEventPhotos).toHaveBeenLastCalledWith(1, expect.objectContaining({ selection: 'out' }));
    });

    getEvent.mockResolvedValue({ ...EVENT, source_mode: 'reference', external_path: 'shoot', selection_path: null, photo_count: 3, video_count: 0 });
    await act(async () => { await qc.invalidateQueries(); });

    await waitFor(() => expect(selectionSelect()).toBeNull());
    await waitFor(() => {
      expect(getEventPhotos.mock.calls.at(-1)?.[1]?.selection).toBeUndefined();
    });
  });
});
