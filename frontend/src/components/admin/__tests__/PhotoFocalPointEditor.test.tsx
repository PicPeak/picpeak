/**
 * The admin moves a photo's crop focus (issue 2377): the viewer shows where
 * it is and offers the editor for images only; a click on the whole photo
 * moves the point, Save stores it, "Use automatic" goes back to the detected
 * one, and a failure keeps the editor open with the reason.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { PhotoFocalPointEditor, focalPointValue, parseFocalPointValue } from '../PhotoFocalPointEditor';
import { AdminPhotoViewer } from '../AdminPhotoViewer';
import type { AdminPhoto } from '../../../services/photos.service';

const { setFocalPoint, toastSuccess } = vi.hoisted(() => ({
  setFocalPoint: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock('../../common', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../common')>()),
  useConfirm: () => async () => true,
  // FocalPointPicker's image: the src and the object-position it previews.
  AuthenticatedImage: ({ src, alt, style }: { src: string; alt: string; style?: React.CSSProperties }) => (
    <img src={src} alt={alt} style={style} />
  ),
}));
vi.mock('react-toastify', () => ({ toast: { error: vi.fn(), success: toastSuccess } }));
let mockCanEdit = true;
vi.mock('../../../hooks/usePermission', () => ({ usePermission: () => mockCanEdit }));
vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return { ...actual, useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) };
});
vi.mock('../AdminAuthenticatedImage', () => ({
  // The picker's image too: the src and the object-position it previews.
  AdminAuthenticatedImage: ({ src, alt, style, onLoad }: {
    src: string; alt: string; style?: React.CSSProperties; onLoad?: React.ReactEventHandler<HTMLImageElement>;
  }) => <img src={src} alt={alt} style={style} onLoad={onLoad} data-admin-image="" />,
}));
vi.mock('../AdminAuthenticatedVideo', () => ({ AdminAuthenticatedVideo: () => null }));
vi.mock('../../../services/photos.service', () => ({
  photosService: { formatBytes: (n: number) => `${n} B`, setFocalPoint },
}));
vi.mock('../../../services/feedback.service', async () => {
  const actual = await vi.importActual<typeof import('../../../services/feedback.service')>('../../../services/feedback.service');
  return { ...actual, feedbackService: { getEventFeedback: vi.fn().mockResolvedValue({ feedback: [] }) } };
});

const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

const base = {
  id: 7, path: '/a', url: '/a', thumbnail_url: '/t/7', category_id: null, category_slug: null,
  size: 1, uploaded_at: '2026-01-01T00:00:00Z', filename: 'couple.jpg', type: 'photo', media_type: 'image',
  width: 1200, height: 600,
};
const photo = (over: Partial<AdminPhoto> = {}) => ({ ...base, ...over }) as unknown as AdminPhoto;
const detected = photo({ focal_point: { x: 0.8, y: 0.4 }, focal_source: 'auto' });

function renderEditor(target: AdminPhoto, onChanged = vi.fn(), onClose = vi.fn()) {
  render(
    <QueryClientProvider client={newClient()}>
      <PhotoFocalPointEditor open onClose={onClose} eventId={42} photo={target} onChanged={onChanged} />
    </QueryClientProvider>
  );
  return { onChanged, onClose };
}

// The picker's box as laid out: 400x200 at the page origin.
function clickPicker(fractionX: number, fractionY: number) {
  const box = screen.getByTestId('focal-point-picker');
  box.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 200, right: 400, bottom: 200, x: 0, y: 0, toJSON: () => ({}) });
  fireEvent.click(box, { clientX: fractionX * 400, clientY: fractionY * 200 });
}

describe('PhotoFocalPointEditor', () => {
  beforeEach(() => {
    setFocalPoint.mockReset();
    toastSuccess.mockReset();
  });

  it('shows the whole photo in its own shape, at the stored point', () => {
    renderEditor(detected);
    const image = screen.getByRole('img', { name: 'couple.jpg' });
    // The preview tier, never the cover-cropped thumbnail.
    expect(image).toHaveAttribute('src', '/admin/photos/42/preview/7');
    // Through the admin session: a gallery token left in session storage
    // would be sent by AuthenticatedImage and refused by the admin route.
    expect(image).toHaveAttribute('data-admin-image');
    expect(image.style.objectPosition).toBe('80% 40%');
    expect(screen.getByTestId('focal-point-picker').style.aspectRatio).toBe('2');
    expect(screen.getByText('admin.photos.focalPoint.isAuto')).toBeInTheDocument();
    // Nothing set by hand: nothing to go back from.
    expect(screen.getByRole('button', { name: 'admin.photos.focalPoint.useAuto' })).toBeDisabled();
  });

  it('stores the clicked point and reports the change', async () => {
    setFocalPoint.mockResolvedValue({ focal_point: { x: 0.25, y: 0.75 }, focal_source: 'manual', thumbnail_url: '/t/7?v=f250-750' });
    const { onChanged, onClose } = renderEditor(detected);

    clickPicker(0.25, 0.75);
    expect(screen.getByRole('img', { name: 'couple.jpg' }).style.objectPosition).toBe('25% 75%');
    await userEvent.setup().click(screen.getByRole('button', { name: 'common.save' }));

    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(setFocalPoint).toHaveBeenCalledWith(42, 7, { x: 0.25, y: 0.75 });
    expect(onClose).toHaveBeenCalled();
  });

  it('goes back to the detected point from one set by hand', async () => {
    setFocalPoint.mockResolvedValue({ focal_point: { x: 0.8, y: 0.4 }, focal_source: 'auto', thumbnail_url: '/t/7?v=f800-400' });
    const { onChanged } = renderEditor(photo({ focal_point: { x: 0.1, y: 0.5 }, focal_source: 'manual' }));

    expect(screen.getByText('admin.photos.focalPoint.isManual')).toBeInTheDocument();
    // Unchanged from what is stored: nothing to save.
    expect(screen.getByRole('button', { name: 'common.save' })).toBeDisabled();
    await userEvent.setup().click(screen.getByRole('button', { name: 'admin.photos.focalPoint.useAuto' }));

    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(setFocalPoint).toHaveBeenCalledWith(42, 7, null);
  });

  it('keeps the editor open with the reason when saving fails', async () => {
    setFocalPoint.mockRejectedValue({ response: { data: { error: 'The thumbnail could not be cut again around that point' } } });
    const { onChanged, onClose } = renderEditor(detected);

    clickPicker(0.5, 0.5);
    await userEvent.setup().click(screen.getByRole('button', { name: 'common.save' }));

    expect(await screen.findByText('The thumbnail could not be cut again around that point')).toBeInTheDocument();
    expect(onChanged).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('takes the shape from the loaded preview when the dimensions are not stored', () => {
    renderEditor(photo({ width: null, height: null, focal_point: { x: 0.8, y: 0.4 }, focal_source: 'auto' } as Partial<AdminPhoto>));
    // Until the preview is in, the box is a crop: no point may be saved from it.
    clickPicker(0.3, 0.3);
    expect(screen.getByRole('button', { name: 'common.save' })).toBeDisabled();

    const image = screen.getByRole('img', { name: 'couple.jpg' });
    Object.defineProperty(image, 'naturalWidth', { value: 900 });
    Object.defineProperty(image, 'naturalHeight', { value: 600 });
    fireEvent.load(image);

    expect(screen.getByTestId('focal-point-picker').style.aspectRatio).toBe('1.5');
    expect(screen.getByRole('button', { name: 'common.save' })).toBeEnabled();
  });

  it('converts between the picker value and the stored point', () => {
    expect(focalPointValue({ x: 0.804, y: 0.4 })).toBe('80% 40%');
    expect(focalPointValue(null)).toBe('50% 50%');
    expect(parseFocalPointValue('25% 100%')).toEqual({ x: 0.25, y: 1 });
    expect(parseFocalPointValue('nonsense')).toEqual({ x: 0.5, y: 0.5 });
  });
});

describe('AdminPhotoViewer crop focus', () => {
  const renderViewer = (target: AdminPhoto, client = newClient()) => render(
    <QueryClientProvider client={client}>
      <AdminPhotoViewer photos={[target]} initialIndex={0} eventId={42} onClose={vi.fn()} onPhotoDeleted={vi.fn()} categories={[]} />
    </QueryClientProvider>
  );

  beforeEach(() => { mockCanEdit = true; setFocalPoint.mockReset(); toastSuccess.mockReset(); });

  it('is offered for an image only, and names where the point came from', () => {
    const { unmount } = renderViewer(detected);
    expect(screen.getByText('admin.photos.focalPoint.isAuto')).toBeInTheDocument();
    expect(screen.getByText('admin.photos.focalPoint.choose')).toBeInTheDocument();
    unmount();
    renderViewer(photo({ media_type: 'video', mime_type: 'video/mp4', filename: 'clip.mp4' }));
    expect(screen.queryByTestId('admin-viewer-focal-point')).not.toBeInTheDocument();
  });

  it('shows a reader without photos.edit the state, not the editor', () => {
    mockCanEdit = false;
    renderViewer(photo());
    expect(screen.getByText('admin.photos.focalPoint.isCentre')).toBeInTheDocument();
    expect(screen.queryByText('admin.photos.focalPoint.choose')).not.toBeInTheDocument();
  });

  it('refreshes the photo list after a save, so the tile shows the new crop', async () => {
    setFocalPoint.mockResolvedValue({ focal_point: { x: 0.25, y: 0.5 }, focal_source: 'manual', thumbnail_url: '/t/7?v=f250-500' });
    const client = newClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const user = userEvent.setup();
    renderViewer(detected, client);

    await user.click(screen.getByText('admin.photos.focalPoint.choose'));
    clickPicker(0.25, 0.5);
    await user.click(screen.getByRole('button', { name: 'common.save' }));

    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['admin-event-photos'] }));
    expect(setFocalPoint).toHaveBeenCalledWith(42, 7, { x: 0.25, y: 0.5 });
    expect(toastSuccess).toHaveBeenCalledWith('admin.photos.focalPoint.saved');
  });
});
