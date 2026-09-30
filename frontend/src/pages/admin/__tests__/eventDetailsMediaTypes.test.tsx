/**
 * /admin/events/:id for an event that holds videos (issue 1430).
 *
 *  - The photo / video select on the Photos tab never rendered. Whether to show
 *    it was derived from the rows on screen by looking for media_type 'photo',
 *    and the API reports a photo as 'image'. It is now derived from the event's
 *    own counts, which also keeps it on screen once a type is chosen: the rows
 *    are what it filters, so they cannot also decide whether it exists.
 *  - The tab and the upload button say "media" for such an event, and keep the
 *    photo wording for an event without videos.
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

vi.mock('../../../contexts/PermissionsContext', () => ({
  usePermissions: () => ({ hasAnyPermission: () => true, hasPermission: () => true, isLoading: false }),
}));

import { EventDetailsPage } from '../EventDetailsPage';

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

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/admin/events/1?tab=photos']}>
        <Routes>
          <Route path="/admin/events/:id" element={<EventDetailsPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

/** The photo / video select, found by its "all" option. */
const mediaSelect = () => screen.queryByRole('option', { name: 'All media' })?.closest('select') ?? null;

describe('EventDetailsPage media types', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getEventPhotos.mockResolvedValue([]);
  });

  it('keeps the photo wording and offers no type filter for an event without videos', async () => {
    getEvent.mockResolvedValue({ ...EVENT, photo_count: 3, video_count: 0 });
    renderPage();

    expect(await screen.findByRole('button', { name: 'events.uploadPhotos' })).toBeInTheDocument();
    expect(screen.getByText('events.photos')).toBeInTheDocument();
    expect(screen.queryByText('Media')).not.toBeInTheDocument();
    expect(mediaSelect()).toBeNull();
  });

  it('says media and offers the type filter for an event that holds both', async () => {
    getEvent.mockResolvedValue({ ...EVENT, photo_count: 5, video_count: 2 });
    renderPage();

    expect(await screen.findByRole('button', { name: 'Upload Photos & Videos' })).toBeInTheDocument();
    expect(screen.getByText('Media')).toBeInTheDocument();
    expect(mediaSelect()).not.toBeNull();
  });

  it('sends the chosen type to the server and keeps the filter on screen', async () => {
    getEvent.mockResolvedValue({ ...EVENT, photo_count: 5, video_count: 2 });
    renderPage();
    await waitFor(() => expect(mediaSelect()).not.toBeNull());

    await userEvent.selectOptions(mediaSelect()!, 'video');

    await waitFor(() => {
      expect(getEventPhotos).toHaveBeenLastCalledWith(1, expect.objectContaining({ media_type: 'video' }));
    });
    // The rows on screen no longer hold both types (here: none at all).
    // Deriving the filter from them hid it at this point and reset the choice,
    // which sent the request above a second time without media_type.
    await screen.findByText('No media uploaded yet');
    expect(mediaSelect()).not.toBeNull();
    expect((mediaSelect() as HTMLSelectElement).value).toBe('video');
    expect(getEventPhotos).toHaveBeenLastCalledWith(1, expect.objectContaining({ media_type: 'video' }));
  });

  it('offers no type filter for an event that holds only videos', async () => {
    getEvent.mockResolvedValue({ ...EVENT, photo_count: 4, video_count: 4 });
    renderPage();

    expect(await screen.findByRole('button', { name: 'Upload Photos & Videos' })).toBeInTheDocument();
    expect(mediaSelect()).toBeNull();
  });
});
