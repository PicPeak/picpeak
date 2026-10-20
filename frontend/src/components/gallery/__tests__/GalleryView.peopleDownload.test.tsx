/**
 * "Download these N" under the people filter (#1074). One archive request
 * holds at most 500 ids on the server, so a larger set has to come as several
 * archives instead of being cut short; the size picker builds one archive, so
 * past 500 it is skipped.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

type StripProps = { onToggle: (personId: number) => void };

const captured = vi.hoisted(() => ({ strip: null as unknown as StripProps, picker: vi.fn() }));

// Hooks hand back the same objects on every render, as the real ones do;
// fresh ones each time would re-run the view's effects without end.
const stable = vi.hoisted(() => ({
  auth: { logout: () => {}, endSession: () => {}, isClient: false, viaCustomer: false },
  theme: { setTheme: () => {}, theme: {} },
  download: { mutate: () => {}, isPending: false },
  settings: { data: {} },
  watermark: { watermarkEnabled: false },
  t: (key: string) => key,
  photos: null as unknown,
}));

const service = vi.hoisted(() => ({
  downloadSelectedPhotos: vi.fn().mockResolvedValue(undefined),
  downloadPhotosInParts: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../contexts', () => ({
  useGalleryAuth: () => stable.auth,
  useTheme: () => stable.theme,
}));

vi.mock('../../../hooks/useGallery', () => ({
  useGalleryPhotos: () => stable.photos,
  useDownloadAllPhotos: () => stable.download,
}));

vi.mock('../../../hooks/usePublicSettings', () => ({ usePublicSettings: () => stable.settings }));
vi.mock('../../../hooks/useWatermarkSettings', () => ({ useWatermarkSettings: () => stable.watermark }));
vi.mock('../../../hooks/useGalleryCustomCss', () => ({ useGalleryCustomCss: () => undefined }));
vi.mock('../../../hooks/useDevToolsProtection', () => ({ useDevToolsProtection: () => undefined }));

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: stable.t, i18n: { language: 'en' } }),
}));
vi.mock('react-toastify', () => ({ toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() } }));

vi.mock('../../../services/analytics.service', () => ({
  analyticsService: { track: vi.fn(), trackGalleryEvent: vi.fn(), trackSearch: vi.fn(), trackExpirationWarning: vi.fn() },
}));
vi.mock('../../../services/gallery.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../services/gallery.service')>();
  return {
    splitIntoArchives: actual.splitIntoArchives,
    galleryService: {
      getPeople: vi.fn().mockResolvedValue({ people: [{ id: 5, name: 'Ana', face_count: 600 }] }),
      downloadSelectedPhotos: service.downloadSelectedPhotos,
      downloadPhotosInParts: service.downloadPhotosInParts,
    },
  };
});
vi.mock('../../../services/feedback.service', () => ({
  feedbackService: {
    getGalleryFeedbackSettings: vi.fn().mockResolvedValue({ feedback_enabled: false }),
    getMyFeedback: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock('../GalleryLayout', () => ({
  GalleryLayout: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('../PhotoGridWithLayouts', () => ({ PhotoGridWithLayouts: () => null }));
vi.mock('../PeopleStrip', () => ({
  PeopleStrip: (props: StripProps) => {
    captured.strip = props;
    return null;
  },
}));
vi.mock('../DownloadResolutionModal', () => ({
  DownloadResolutionModal: (props: { photoIds?: number[] }) => {
    captured.picker(props.photoIds);
    return null;
  },
}));

import { GalleryView } from '../GalleryView';

const event = {
  id: 1,
  event_name: 'Hoa Wedding',
  event_type: 'wedding',
  event_date: '2026-09-19',
  expires_at: '2099-09-19T00:00:00Z',
};

const photosOfAna = (count: number) => Array.from({ length: count }, (_, i) => ({
  id: i + 1,
  filename: `p${i + 1}.jpg`,
  url: `/p${i + 1}.jpg`,
  thumbnail_url: `/p${i + 1}-t.jpg`,
  type: 'photo',
  size: 1,
  uploaded_at: '2026-09-19T10:00:00Z',
  person_ids: [5],
}));

function show(count: number, pickerEnabled = false) {
  stable.photos = {
    data: {
      event: {
        ...event,
        allow_downloads: true,
        people_enabled: true,
        download_resolution: pickerEnabled
          ? { picker_enabled: true, standard: 'original', choices: [{ id: 'original' }, { id: '1920x1080' }] }
          : undefined,
      },
      categories: [],
      photos: photosOfAna(count),
    },
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <GalleryView slug="wedding" event={event} />
    </QueryClientProvider>,
  );
}

async function downloadThese() {
  await waitFor(() => expect(captured.strip).toBeTruthy());
  act(() => captured.strip.onToggle(5));
  fireEvent.click(await screen.findByText('gallery.people.downloadThese'));
}

beforeEach(() => {
  service.downloadSelectedPhotos.mockClear();
  service.downloadPhotosInParts.mockClear();
  captured.picker.mockClear();
});
afterEach(cleanup);

describe('GalleryView — people filter download', () => {
  it('downloads every photo of the person past 500, in parts', async () => {
    show(1201);
    await downloadThese();
    await waitFor(() => expect(service.downloadPhotosInParts).toHaveBeenCalledTimes(1));
    expect(service.downloadPhotosInParts.mock.calls[0][1]).toHaveLength(1201);
    expect(service.downloadSelectedPhotos).not.toHaveBeenCalled();
  });

  it('skips the size picker past 500, which builds one archive', async () => {
    show(600, true);
    await downloadThese();
    await waitFor(() => expect(service.downloadPhotosInParts).toHaveBeenCalledTimes(1));
    expect(service.downloadPhotosInParts.mock.calls[0][1]).toHaveLength(600);
    expect(captured.picker).not.toHaveBeenCalledWith(expect.arrayContaining([1]));
  });

  it('still offers the size picker within 500', async () => {
    show(3, true);
    await downloadThese();
    await waitFor(() => expect(captured.picker).toHaveBeenCalledWith([1, 2, 3]));
    expect(service.downloadPhotosInParts).not.toHaveBeenCalled();
  });
});
