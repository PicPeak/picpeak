/**
 * Gallery Premium uses its own yarl lightbox, so the admin's maximum lightbox
 * zoom has to reach yarl's Zoom plugin as a pixel ratio.
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import type { Photo } from '../../../types';

const quota = vi.hoisted(() => ({ remaining: 10 }));
const settings = vi.hoisted(() => ({ current: undefined as { gallery_lightbox_max_zoom_percent?: number } | undefined }));
const lightboxProps = vi.hoisted(() => ({ zoom: undefined as { maxZoomPixelRatio?: number } | undefined }));
const mocks = vi.hoisted(() => ({
  downloadSelectedPhotos: vi.fn(),
  showDownloadLimitReached: vi.fn(),
}));

vi.mock('../../../hooks/usePublicSettings', () => ({ usePublicSettings: () => ({ data: settings.current }) }));
vi.mock('react-i18next', async () => ({
  ...await vi.importActual('react-i18next'),
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('react-toastify', () => ({ toast: { info: vi.fn(), error: vi.fn() } }));
vi.mock('../../../hooks/useGallery', () => ({ useDownloadPhoto: () => ({ mutate: vi.fn() }) }));
vi.mock('../../../contexts/GuestIdentityContext', () => ({ useGuestIdentityOptional: () => null }));
vi.mock('../../../hooks/useInputMode', () => ({ useInputMode: () => 'mouse' }));
vi.mock('react-intersection-observer', () => ({ useInView: () => ({ ref: vi.fn(), inView: true }) }));
vi.mock('../../../contexts/DownloadQuotaContext', () => {
  const cost = (list: Array<{ download_granted?: boolean }>) => list.filter((p) => !p.download_granted).length;
  return {
    useDownloadQuota: () => ({
      limited: true,
      previewOnly: false,
      remaining: quota.remaining,
      allows: (list: Array<{ download_granted?: boolean }>) => cost(list) <= quota.remaining,
      canDownload: () => true,
      costOf: cost,
    }),
  };
});
vi.mock('../DownloadQuotaNotice', () => ({ DownloadQuotaNotice: () => null }));
vi.mock('../../../utils/downloadLimit', () => ({
  isDownloadLimitError: () => false,
  showDownloadLimitReached: mocks.showDownloadLimitReached,
}));
vi.mock('../../../services/gallery.service', async () => {
  const actual = await vi.importActual<typeof import('../../../services/gallery.service')>('../../../services/gallery.service');
  return {
    splitIntoArchives: actual.splitIntoArchives,
    galleryService: {
      trackPhotoView: vi.fn(),
      downloadSelectedPhotos: mocks.downloadSelectedPhotos,
      downloadPhotosInParts: actual.galleryService.downloadPhotosInParts,
    },
  };
});
vi.mock('../../../services/analytics.service', () => ({ analyticsService: { trackGalleryEvent: vi.fn() } }));
vi.mock('../../common', async () => ({ ...await vi.importActual('../../common'), PoweredBy: () => null }));
vi.mock('react-photo-album', () => ({
  MasonryPhotoAlbum: ({ photos, render: renderer }: any) => <>{photos.map((photo: any, index: number) =>
    <React.Fragment key={photo.key}>{renderer.photo({}, { photo, index, width: 300, height: 200 })}</React.Fragment>
  )}</>,
}));
vi.mock('yet-another-react-lightbox', () => ({
  default: (props: { zoom?: { maxZoomPixelRatio?: number } }) => {
    lightboxProps.zoom = props.zoom;
    return null;
  },
}));
vi.mock('yet-another-react-lightbox/plugins/thumbnails', () => ({ default: () => null }));
vi.mock('yet-another-react-lightbox/plugins/zoom', () => ({ default: () => null }));
vi.mock('yet-another-react-lightbox/plugins/fullscreen', () => ({ default: () => null }));
vi.mock('yet-another-react-lightbox/plugins/download', () => ({ default: () => null }));
vi.mock('yet-another-react-lightbox/plugins/captions', () => ({ default: () => null }));

import { GalleryPremiumLayout } from '../layouts/GalleryPremiumLayout';

const photos = [1, 2].map((id) => ({
  id, filename: `photo-${id}.jpg`,
  url: `/api/gallery/demo/photo/${id}`, thumbnail_url: `/api/gallery/demo/thumbnail/${id}`,
  width: 6000, height: 4000, type: 'individual', size: 1, uploaded_at: '2026-01-01T00:00:00Z',
})) as Photo[];

afterEach(() => {
  cleanup();
  settings.current = undefined;
  lightboxProps.zoom = undefined;
});

const renderLayout = (props: Partial<React.ComponentProps<typeof GalleryPremiumLayout>> = {}) => render(
  <GalleryPremiumLayout photos={photos} slug="demo" onPhotoClick={vi.fn()} onDownload={vi.fn()} {...props} />,
);

describe('Gallery Premium — maximum lightbox zoom (issue 2281)', () => {
  it('keeps Zoom at the loaded image pixels by default', () => {
    renderLayout();
    expect(lightboxProps.zoom).toEqual({ maxZoomPixelRatio: 1 });
  });

  it('scales the pixel limit by the admin percent', () => {
    settings.current = { gallery_lightbox_max_zoom_percent: 800 };
    renderLayout();
    expect(lightboxProps.zoom).toEqual({ maxZoomPixelRatio: 8 });
  });

  it.each([
    ['canvas rendering', { useCanvasRendering: true }],
    ['maximum protection', { protectionLevel: 'maximum' as const }],
  ])('keeps the old limit with %s', (_label, props) => {
    settings.current = { gallery_lightbox_max_zoom_percent: 1000 };
    renderLayout(props);
    expect(lightboxProps.zoom).toEqual({ maxZoomPixelRatio: 1 });
  });
});
