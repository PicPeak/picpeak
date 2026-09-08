/**
 * Who hears about a file of the wrong type, now that a drop is walked.
 *
 * A dropped file no longer reaches the selection pipeline directly: the walk
 * filters it first, so a file it throws away never gets as far as the code
 * that names it. The names are gathered at the drop instead, and only for
 * the items the user dropped by hand. A folder of camera RAW sits next to an
 * XMP sidecar per shot, and listing every sidecar would bury the one line
 * the user needs.
 *
 * Pins:
 *  - a file dropped by hand is named
 *  - a file picked from the chooser is named
 *  - an unsupported file inside a dropped folder is silent
 *  - a camera RAW the browser reports no type for is still admitted by the
 *    walk, which is what decides whether a dropped folder of RAW works
 */
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PhotoUpload } from '../PhotoUpload';
import { renderWithUploadSession as renderWithClient } from './uploadTestUtils';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, opts?: any) =>
        (opts && typeof opts.names === 'string' ? `${key}:${opts.names}` : key),
    }),
  };
});

const toastWarning = vi.fn();
const toastError = vi.fn();
vi.mock('react-toastify', () => ({
  toast: {
    warning: (...a: any[]) => toastWarning(...a),
    info: vi.fn(),
    error: (...a: any[]) => toastError(...a),
    success: vi.fn(),
  },
}));

vi.mock('../../../config/api', () => ({ api: { post: vi.fn(), get: vi.fn() } }));

vi.mock('../../../hooks/useUploadProgress', () => ({
  useUploadProgress: () => ({
    snapshots: {},
    error: null,
    aggregate: { total: 0, pending: 0, processing: 0, complete: 0, failed: 0, failedPhotos: [], isComplete: false, isReady: true },
  }),
}));

vi.mock('../../../services/categories.service', () => ({
  categoriesService: { getEventCategories: vi.fn().mockResolvedValue([]) },
}));
const settingsMock = vi.fn();
vi.mock('../../../services/settings.service', () => ({
  settingsService: { getAllSettings: (...a: any[]) => settingsMock(...a) },
}));
// mp4 is here only so the video hint renders, which is the signal that the
// settings query has resolved and the list below is the one in force.
const DEFAULT_SETTINGS = {
  general_allowed_file_types: 'jpg,jpeg,png,webp,mp4,arw',
  general_max_files_per_upload: 10,
};

// The browser reports no type for a camera RAW, and none for a sidecar.
const untyped = (name: string) => new File(['x'], name, { type: '' });

const fileEntry = (name: string, file: File) => ({
  isFile: true,
  isDirectory: false,
  name,
  file: (ok: (f: File) => void) => ok(file),
});

const dirEntry = (name: string, children: object[]) => ({
  isFile: false,
  isDirectory: true,
  name,
  createReader: () => {
    let done = false;
    return {
      readEntries: (ok: (entries: object[]) => void) => {
        ok(done ? [] : children);
        done = true;
      },
    };
  },
});

const settled = async () => {
  const { container } = renderWithClient(<PhotoUpload eventId={1} />);
  await waitFor(() => expect(screen.getByText('upload.videoSizeLimit')).toBeInTheDocument());
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  return { input, zone: input.parentElement! };
};

describe('PhotoUpload wrong-type reporting', () => {
  beforeEach(() => {
    toastWarning.mockReset();
    toastError.mockReset();
    settingsMock.mockReset();
    settingsMock.mockResolvedValue(DEFAULT_SETTINGS);
  });

  it('names a file dropped by hand', async () => {
    const { zone } = await settled();
    fireEvent.drop(zone, {
      dataTransfer: {
        files: [],
        items: [{ kind: 'file', webkitGetAsEntry: () => fileEntry('notes.txt', untyped('notes.txt')) }],
      },
    });

    await waitFor(() => expect(toastError).toHaveBeenCalledWith('upload.invalidFileType:notes.txt'));
    expect(screen.queryByText('notes.txt')).not.toBeInTheDocument();
  });

  it('names a file picked from the chooser', async () => {
    const { input } = await settled();
    fireEvent.change(input, { target: { files: [untyped('notes.txt')] } });

    await waitFor(() => expect(toastError).toHaveBeenCalledWith('upload.invalidFileType:notes.txt'));
  });

  it('takes an untyped camera RAW out of a dropped folder and says nothing about the sidecars', async () => {
    const { zone } = await settled();
    fireEvent.drop(zone, {
      dataTransfer: {
        files: [],
        items: [{
          kind: 'file',
          webkitGetAsEntry: () => dirEntry('shoot', [
            fileEntry('DSC01.ARW', untyped('DSC01.ARW')),
            fileEntry('DSC01.XMP', untyped('DSC01.XMP')),
            fileEntry('DSC02.ARW', untyped('DSC02.ARW')),
            fileEntry('DSC02.XMP', untyped('DSC02.XMP')),
          ]),
        }],
      },
    });

    await waitFor(() => expect(screen.getByText('DSC01.ARW')).toBeInTheDocument());
    expect(screen.getByText('DSC02.ARW')).toBeInTheDocument();
    expect(screen.queryByText('DSC01.XMP')).not.toBeInTheDocument();
    expect(toastError).not.toHaveBeenCalled();
    expect(toastWarning).not.toHaveBeenCalled();
  });

  it('keeps an untyped camera RAW dropped by hand', async () => {
    const { zone } = await settled();
    fireEvent.drop(zone, {
      dataTransfer: {
        files: [],
        items: [{ kind: 'file', webkitGetAsEntry: () => fileEntry('DSC03.ARW', untyped('DSC03.ARW')) }],
      },
    });

    await waitFor(() => expect(screen.getByText('DSC03.ARW')).toBeInTheDocument());
    expect(toastError).not.toHaveBeenCalled();
  });
});
