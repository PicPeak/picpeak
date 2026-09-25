/**
 * A guest on a phone can open the camera directly (issue 1563, B4).
 *
 * The dropzone's file input opens the system chooser, which on some Android
 * 14+ builds is the restricted photo picker with no camera entry. A second,
 * single-shot input with `capture="environment"` bypasses it, behind a button
 * that shows on coarse-pointer devices and only when the upload policy would
 * accept a JPEG. It feeds the same selection handler, so a captured photo is
 * treated exactly like a picked one.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { UserPhotoUpload } from '../UserPhotoUpload';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, second?: any) => (typeof second === 'string' ? second : key),
    }),
  };
});
vi.mock('react-toastify', () => ({ toast: { warning: vi.fn(), info: vi.fn(), error: vi.fn(), success: vi.fn() } }));
vi.mock('../../../config/api', () => ({ api: { post: vi.fn() } }));
const publicSettings = vi.hoisted(() => ({ data: {} as Record<string, unknown> }));
vi.mock('../../../hooks/usePublicSettings', () => ({ usePublicSettings: () => publicSettings }));

const renderUploader = () => render(
  <UserPhotoUpload eventId={7} categoryId={null} onUploadComplete={vi.fn()} onClose={vi.fn()} />
);

describe('UserPhotoUpload camera button', () => {
  afterEach(() => { vi.clearAllMocks(); publicSettings.data = {}; });

  it('is not offered when the upload policy would refuse a JPEG', () => {
    publicSettings.data = { allowed_file_types: 'png,webp' };
    const { container } = renderUploader();
    expect(container.querySelectorAll('input[type="file"]')).toHaveLength(1);
    expect(screen.queryByTestId('camera-input')).toBeNull();
  });

  it('is not offered on a fine-pointer device', () => {
    const matchMedia = vi.fn().mockReturnValue({ matches: false });
    vi.stubGlobal('matchMedia', matchMedia);
    try {
      renderUploader();
      expect(matchMedia).toHaveBeenCalledWith('(pointer: coarse)');
      expect(screen.queryByTestId('camera-input')).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('offers a capture input that opens the camera, separate from the dropzone input', () => {
    const { container } = renderUploader();
    const inputs = container.querySelectorAll('input[type="file"]');
    expect(inputs).toHaveLength(2);
    // The dropzone's input comes first, unchanged — the other tests and the
    // drag-and-drop path rely on it.
    expect(inputs[0].getAttribute('capture')).toBeNull();
    expect(inputs[0]).toHaveAttribute('multiple');
    const camera = screen.getByTestId('camera-input');
    expect(camera).toBe(inputs[1]);
    expect(camera).toHaveAttribute('capture', 'environment');
    expect(camera).toHaveAttribute('accept', 'image/*');
    expect(camera).not.toHaveAttribute('multiple');
  });

  it('the button opens that input', async () => {
    const user = userEvent.setup();
    renderUploader();
    const camera = screen.getByTestId('camera-input') as HTMLInputElement;
    const click = vi.spyOn(camera, 'click');
    await user.click(screen.getByRole('button', { name: /upload\.takePhoto/ }));
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('a captured photo lands in the selection like a picked one', async () => {
    const user = userEvent.setup();
    renderUploader();
    const camera = screen.getByTestId('camera-input') as HTMLInputElement;
    await user.upload(camera, new File([new Uint8Array([1, 2, 3])], 'IMG_0001.jpg', { type: 'image/jpeg' }));
    expect(screen.getByText('IMG_0001.jpg')).toBeInTheDocument();
  });
});
