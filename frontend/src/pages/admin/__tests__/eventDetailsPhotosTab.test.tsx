/**
 * Two QA follow-ups on /admin/events/:id, both observable on the Photos tab:
 *
 *  - `?tab=photos` was ignored — the page always mounted on Overview, unlike
 *    Settings which seeds its tab state from the same param.
 *  - With the network down, the photos query failed and the grid fell through
 *    to its "no media uploaded yet" empty state, so an admin could reasonably
 *    conclude the photos were gone.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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
const deletePhotos = vi.fn();
vi.mock('../../../services/photos.service', () => ({
  CREDIT_FILTER_NONE: '__none__',
  photosService: {
    getEventPhotos: (...args: unknown[]) => getEventPhotos(...args),
    getFilterSummary: vi.fn().mockResolvedValue({}),
    getExportFormats: vi.fn().mockResolvedValue([]),
    getPhotoCredits: vi.fn().mockResolvedValue({ credits: [], none: 0 }),
    getModerationCounts: vi.fn().mockResolvedValue({ pending: 0, rejected: 0 }),
    getTrash: vi.fn().mockResolvedValue({ items: [], retention_days: 30 }),
    formatBytes: () => '100 B',
    deletePhotos: (...args: unknown[]) => deletePhotos(...args),
  },
}));

vi.mock('../../../components/common', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../components/common')>()),
  useConfirm: () => async () => true,
}));
vi.mock('../../../components/admin/AdminAuthenticatedImage', () => ({
  AdminAuthenticatedImage: ({ alt }: { alt: string }) => <img alt={alt} />,
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
  photo_count: 3,
  source_mode: 'managed',
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
              <Route path="/admin/events" element={<div>events list</div>} />
            </Routes>
          </MemoryRouter>
        </UnsavedChangesProvider>
      </ConfirmDialogProvider>
    </QueryClientProvider>
  );
}

describe('EventDetailsPage photos tab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getEvent.mockResolvedValue(EVENT);
    getEventPhotos.mockResolvedValue([]);
    deletePhotos.mockResolvedValue({ trashed: 2, deleted: 0, failed: [], retention_days: 30 });
  });

  it('honours a ?tab=photos deep link instead of landing on Overview', async () => {
    renderPage('/admin/events/1?tab=photos');

    await waitFor(() => {
      expect(screen.getByText('events.uploadPhotos')).toBeInTheDocument();
    });
    // Overview-only control must not be on screen.
    expect(screen.queryByText('events.eventInformation')).not.toBeInTheDocument();
  });

  it('falls back to Overview for an unknown ?tab= value', async () => {
    renderPage('/admin/events/1?tab=nonsense');

    await waitFor(() => {
      expect(screen.queryByText('events.uploadPhotos')).not.toBeInTheDocument();
    });
  });

  it('renders an error with retry, not the empty state, when the photos query fails', async () => {
    getEventPhotos.mockRejectedValue(new Error('Network Error'));

    renderPage('/admin/events/1?tab=photos');

    await waitFor(() => {
      expect(screen.getByText('gallery.failedToLoad')).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'common.retry' })).toBeInTheDocument();
    expect(screen.queryByText('No media uploaded yet')).not.toBeInTheDocument();
  });
  it('clears the entire selection on visibility changes, including cached views, then bulk-deletes only hidden picks', async () => {
    const photos = [1, 2, 3].map((id) => ({
      id, filename: `IMG_${id}.jpg`, path: `/photos/${id}.jpg`, url: `/photos/${id}.jpg`, thumbnail_url: `/thumb/${id}.jpg`,
      type: 'individual', category_id: null, category_name: null, category_slug: null,
      size: 100, uploaded_at: '2026-10-01T00:00:00Z', visibility: id === 1 ? 'visible' : 'hidden',
    }));
    getEventPhotos.mockImplementation(async (_id: number, filters?: { visibility?: string }) =>
      photos.filter((p) => !filters?.visibility || p.visibility === filters.visibility));
    renderPage('/admin/events/1?tab=photos');
    await userEvent.click(await screen.findByTestId('admin-photo-checkbox-1'));
    expect(screen.getByRole('button', { name: 'Delete Selected' })).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Photo visibility' }), 'hidden');
    expect(await screen.findByTestId('admin-photo-checkbox-2')).toHaveAttribute('aria-checked', 'false');
    expect(screen.queryByTestId('admin-photo-checkbox-1')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete Selected' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId('admin-photo-checkbox-2'));

    // Both views are cached now: changing the filter must still reset the grid.
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Photo visibility' }), 'all');
    expect(await screen.findByTestId('admin-photo-checkbox-2')).toHaveAttribute('aria-checked', 'false');
    expect(screen.queryByRole('button', { name: 'Delete Selected' })).not.toBeInTheDocument();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Photo visibility' }), 'hidden');
    await userEvent.click(await screen.findByTestId('admin-photo-checkbox-2'));
    await userEvent.click(screen.getByTestId('admin-photo-checkbox-3'));
    await userEvent.click(screen.getByRole('button', { name: 'Delete Selected' }));
    await waitFor(() => expect(deletePhotos).toHaveBeenCalledWith(1, [2, 3]));
  });

  it.each(['visible', 'hidden'])('combines %s visibility with existing filters and sorting, then clears back to All Photos', async (visibility) => {
    renderPage('/admin/events/1?tab=photos');
    await userEvent.selectOptions(await screen.findByRole('combobox', { name: 'Photo visibility' }), visibility);
    await userEvent.type(screen.getByPlaceholderText('Search by filename...'), 'IMG');
    const category = screen.getByRole('option', { name: 'Uncategorized' }).parentElement as HTMLSelectElement;
    await userEvent.selectOptions(category, 'uncategorized');
    const sort = screen.getByRole('option', { name: 'Sort by Name' }).parentElement as HTMLSelectElement;
    await userEvent.selectOptions(sort, 'name');
    const filters = { search: 'IMG', category_id: 'uncategorized', sort: 'name', order: 'desc' };
    await waitFor(() => expect(getEventPhotos).toHaveBeenLastCalledWith(1, expect.objectContaining({ ...filters, visibility })));
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Photo visibility' }), 'all');
    await waitFor(() => expect(getEventPhotos).toHaveBeenLastCalledWith(1, expect.objectContaining({ ...filters, visibility: undefined })));
  });

  it('explains an empty visibility-filter result without saying the gallery has no uploads', async () => {
    renderPage('/admin/events/1?tab=photos');
    await userEvent.selectOptions(await screen.findByRole('combobox', { name: 'Photo visibility' }), 'hidden');
    expect(await screen.findByText('No photos match the selected visibility and filters.')).toBeInTheDocument();
    expect(screen.queryByText('No media uploaded yet')).not.toBeInTheDocument();
  });

});
