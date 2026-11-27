/**
 * Saving in the photo editor (issue 2619): the server's normalised edit (a
 * RAW is saved with develop on) becomes the saved state without a phantom
 * "not saved"; moving on waits for a save still on its way; a copy to more
 * photos than one request takes goes out in parts.
 */
import React from 'react';
import { act, render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { service, toast } = vi.hoisted(() => ({
  service: {
    get: vi.fn(), baseImage: vi.fn(), developPreview: vi.fn(), save: vi.fn(), copyTo: vi.fn(), status: vi.fn(),
    listPresets: vi.fn(), settings: vi.fn(), saveSettings: vi.fn(), createPreset: vi.fn(), deletePreset: vi.fn(), developRaw: vi.fn(),
  },
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('../../../services/photoEditor.service', () => ({ photoEditorService: service }));
vi.mock('react-toastify', () => ({ toast }));
vi.mock('react-i18next', async () => ({
  ...(await vi.importActual<typeof import('react-i18next')>('react-i18next')),
  useTranslation: () => ({
    t: (key: string, fallback?: any) => {
      if (typeof fallback === 'string') return fallback;
      if (fallback?.defaultValue) return String(fallback.defaultValue).replace(/\{\{(\w+)\}\}/g, (_: string, name: string) => String(fallback[name]));
      return key;
    },
    i18n: { language: 'en' },
  }),
}));
vi.mock('../../../components/common', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../components/common')>()),
  useConfirm: () => async () => true,
}));
vi.mock('../../../components/admin/AdminAuthenticatedImage', () => ({ AdminAuthenticatedImage: () => null }));
vi.mock('../renderer', () => ({
  EditRenderer: class {
    backend = 'webgl2';
    width = 600;
    height = 400;
    linear = false;
    render() { return { width: 600, height: 400, crop: { left: 0, top: 0, width: 600, height: 400 } }; }
    toneStats() { return { p005: -8, p10: -6, p50: -3, p99: -0.5, p995: -0.2, mean: -3, clipped: 0 }; }
    dispose() {}
  },
}));

import PhotoEditor from '../PhotoEditor';
import { BatchCopyDialog } from '../BatchCopyDialog';
import { DEFAULT_PARAMS } from '../editMath';

const photos = [1, 2].map((id) => ({ id, filename: `p${id}.cr3`, media_type: 'image', mime_type: 'image/x-canon-cr3' })) as any;
const state = (id: number, params: unknown = null) => ({ photo_id: id, raw: true, source_version: 'abc', params, edit_rev: 0, edit_applied_rev: 0, width: 600, height: 400 });

beforeEach(() => {
  vi.clearAllMocks();
  (globalThis as any).createImageBitmap = vi.fn().mockResolvedValue({ width: 600, height: 400 });
  (globalThis as any).ResizeObserver = class { observe() {} disconnect() {} };
  service.get.mockImplementation(async (_e: number, id: number) => state(id));
  service.developPreview.mockResolvedValue({ width: 600, height: 400, data: new Uint16Array(600 * 400 * 3), exposureBias: 0 });
  service.listPresets.mockResolvedValue([]);
  service.settings.mockResolvedValue({ auto_develop_raw: false });
  service.status.mockResolvedValue({ pending: 0, failed: 0, pending_ids: [], failed_ids: [] });
});

const open = async () => {
  render(<PhotoEditor eventId={1} photos={photos} initialPhotoId={1} onClose={vi.fn()} onChanged={vi.fn()} />);
  await waitFor(() => expect(screen.getByLabelText('Edited preview')).toHaveAttribute('data-backend', 'webgl2'));
};

describe('saving', () => {
  it('takes the normalised edit a RAW is saved with, so nothing stays unsaved', async () => {
    service.save.mockImplementation(async (_e: number, id: number, params: any) => state(id, params));
    await open();
    fireEvent.change(screen.getByLabelText('photoEditor.sliders.exposure'), { target: { value: '1' } });
    expect(screen.getByText('Not saved')).toBeInTheDocument();
    await userEvent.click(screen.getAllByRole('button', { name: 'Save' })[0]);
    await waitFor(() => expect(service.save).toHaveBeenCalled());
    expect(service.save.mock.calls[0][2]).toMatchObject({ exposure: 1, develop: true });
    await waitFor(() => expect(screen.queryByText('Not saved')).toBeNull());
  });

  it('moves to the next photo only once a save on its way has landed', async () => {
    let finish: (value: unknown) => void = () => {};
    service.save.mockImplementation((_e: number, id: number, params: any) => new Promise((resolve) => { finish = () => resolve(state(id, params)); }));
    await open();
    fireEvent.change(screen.getByLabelText('photoEditor.sliders.exposure'), { target: { value: '0.5' } });
    await userEvent.click(screen.getAllByRole('button', { name: 'Save' })[0]);
    await userEvent.click(screen.getByRole('button', { name: 'Next photo' }));
    expect(service.get).toHaveBeenCalledTimes(1);
    await act(async () => { finish(undefined); });
    await waitFor(() => expect(service.get).toHaveBeenCalledWith(1, 2));
    expect(service.save).toHaveBeenCalledTimes(1);
  });
});

describe('while the next photo loads', () => {
  it('nothing can be changed or saved, and a late answer does not touch the photo shown', async () => {
    const { EditRenderer } = await import('../renderer');
    const dispose = vi.spyOn(EditRenderer.prototype as any, 'dispose');
    let release: () => void = () => {};
    service.get.mockImplementation(async (_e: number, id: number) => {
      if (id === 2) await new Promise<void>((resolve) => { release = resolve; });
      return state(id);
    });
    await open();
    await userEvent.click(screen.getByRole('button', { name: 'Next photo' }));
    await waitFor(() => expect(service.get).toHaveBeenCalledWith(1, 2));
    // Photo 2's state is not here: the sliders and Save are off, Ctrl+S does nothing.
    expect(screen.getByLabelText('photoEditor.sliders.exposure')).toBeDisabled();
    fireEvent.change(screen.getByLabelText('photoEditor.sliders.exposure'), { target: { value: '1' } });
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    expect(service.save).not.toHaveBeenCalled();
    // Back to photo 1 before photo 2 answered; its late answer must not
    // dispose the renderer photo 1 now has.
    await userEvent.click(screen.getByRole('button', { name: 'Previous photo' }));
    await waitFor(() => expect(screen.getByLabelText('photoEditor.sliders.exposure')).not.toBeDisabled());
    const disposedBefore = dispose.mock.calls.length;
    await act(async () => { release(); });
    await new Promise((r) => setTimeout(r, 20));
    expect(dispose.mock.calls.length).toBe(disposedBefore);
    dispose.mockRestore();
  });
});

describe('background progress', () => {
  it('follows every queued photo, asking for them in parts, until each is done', async () => {
    const many = Array.from({ length: 700 }, (_, i) => ({ id: i + 10, filename: `x${i}.jpg`, media_type: 'image' }));
    service.copyTo.mockImplementation(async (_e: number, ids: number[]) => ({ queued: ids.length, skipped: [] }));
    let done = false;
    service.status.mockImplementation(async (_e: number, ids?: number[]) => {
      const pending = done || !ids ? [] : ids;
      return { pending: pending.length, failed: 0, pending_ids: pending, failed_ids: [] };
    });
    render(<PhotoEditor eventId={1} photos={[...photos, ...many] as any} initialPhotoId={1} onClose={vi.fn()} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByLabelText('Edited preview')).toHaveAttribute('data-backend', 'webgl2'));
    await userEvent.click(screen.getByRole('button', { name: 'Copy to photos…' }));
    await userEvent.click(screen.getByRole('button', { name: 'Select all' }));
    await userEvent.click(screen.getByRole('button', { name: /Copy to 701 photos/ }));
    await waitFor(() => expect(service.status).toHaveBeenCalled(), { timeout: 4000 });
    const asked = service.status.mock.calls.map((call) => call[1]?.length);
    expect(Math.max(...asked)).toBeLessThanOrEqual(500);
    expect(screen.getByText(/for 701 photos/)).toBeInTheDocument();
    done = true;
    await waitFor(() => expect(screen.queryByText(/for 701 photos/)).toBeNull(), { timeout: 4000 });
  }, 15000);
});

describe('copy to photos', () => {
  it('sends more than a request takes in parts and adds up the result', async () => {
    const many = Array.from({ length: 1500 }, (_, i) => ({ id: i + 10, filename: `x${i}.jpg`, media_type: 'image' })) as any;
    service.copyTo.mockImplementation(async (_e: number, ids: number[]) => ({ queued: ids.length, skipped: [] }));
    const onQueued = vi.fn();
    render(<BatchCopyDialog open onClose={vi.fn()} eventId={1} photos={many} sourceId={1} params={{ ...DEFAULT_PARAMS, exposure: 1 }} onQueued={onQueued} />);
    await userEvent.click(screen.getByRole('button', { name: 'Select all' }));
    await userEvent.click(screen.getByRole('button', { name: /Copy to 1500 photos/ }));
    await waitFor(() => expect(onQueued).toHaveBeenCalled());
    expect(service.copyTo.mock.calls.map((call) => call[1].length)).toEqual([1000, 500]);
    expect(onQueued.mock.calls[0][0]).toHaveLength(1500);
  });
});
