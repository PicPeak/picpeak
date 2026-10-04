/**
 * Dropping a folder onto the admin uploader (issue 1733, backlog item C1).
 *
 * The drop handler used to read only `dataTransfer.files`, where a folder
 * shows up as one zero-byte entry the type filter throws away. Folders are
 * now walked through `dataTransfer.items` and the result goes through the
 * same `addFiles` pipeline as picked files.
 *
 * Pins:
 *  - the files inside a dropped folder end up in the selection
 *  - a folder over the per-upload cap is truncated with the picker's notice
 *  - a drop without the entry API still takes `dataTransfer.files`
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
        (opts && typeof opts.allowed === 'number' ? `${key}:${opts.allowed}:${opts.limit}` : key),
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
const DEFAULT_SETTINGS = {
  general_allowed_file_types: 'jpg,jpeg,png,webp,mp4',
  general_max_files_per_upload: 3,
};

const jpg = (name: string) => new File(['x'], name, { type: 'image/jpeg' });

const fileEntry = (name: string) => ({
  isFile: true,
  isDirectory: false,
  name,
  file: (ok: (f: File) => void) => ok(jpg(name)),
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

const dropOnZone = async (dataTransfer: object) => {
  const { container } = renderWithClient(<PhotoUpload eventId={1} />);
  // Wait for the settings query so the cap is not still at its default.
  await waitFor(() => expect(screen.getByText('upload.videoSizeLimit')).toBeInTheDocument());
  const zone = container.querySelector('input[type="file"]')!.parentElement!;
  fireEvent.drop(zone, { dataTransfer });
};

describe('PhotoUpload folder drop', () => {
  beforeEach(() => {
    toastWarning.mockReset();
    toastError.mockReset();
    settingsMock.mockReset();
    settingsMock.mockResolvedValue(DEFAULT_SETTINGS);
  });

  it('validates a walk that lands after the settings resolved with the resolved limits', async () => {
    // Settings resolve only when released; the walk is dropped before that.
    // The defaults (no mp4) would reject the video; the resolved list keeps it.
    let releaseSettings: (() => void) | null = null;
    settingsMock.mockImplementation(() => new Promise((ok) => {
      releaseSettings = () => ok({ ...DEFAULT_SETTINGS, general_allowed_file_types: 'mp4' });
    }));
    let releaseWalk: (() => void) | null = null;
    const slowDir = {
      isFile: false, isDirectory: true, name: 'clips',
      createReader: () => {
        let done = false;
        return {
          readEntries: (ok: (entries: object[]) => void) => {
            const answer = () => {
              ok(done ? [] : [{ isFile: true, isDirectory: false, name: 'clip.mp4',
                file: (cb: (f: File) => void) => cb(new File(['x'], 'clip.mp4', { type: 'video/mp4' })) }]);
              done = true;
            };
            if (done) answer(); else releaseWalk = answer;
          },
        };
      },
    };
    const { container } = renderWithClient(<PhotoUpload eventId={1} />);
    const zone = container.querySelector('input[type="file"]')!.parentElement!;
    fireEvent.drop(zone, { dataTransfer: { files: [], items: [{ kind: 'file', webkitGetAsEntry: () => slowDir }] } });

    releaseSettings!();
    await waitFor(() => expect(screen.getByText('upload.videoSizeLimit')).toBeInTheDocument());
    releaseWalk!();

    await waitFor(() => expect(screen.getByText('clip.mp4')).toBeInTheDocument());
    expect(toastError).not.toHaveBeenCalled();
  });

  it('selects the files inside a dropped folder', async () => {
    await dropOnZone({
      files: [],
      items: [{ kind: 'file', webkitGetAsEntry: () => dirEntry('shoot', [fileEntry('b.jpg'), fileEntry('a.jpg')]) }],
    });

    await waitFor(() => expect(screen.getByText('a.jpg')).toBeInTheDocument());
    expect(screen.getByText('b.jpg')).toBeInTheDocument();
    expect(toastWarning).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });

  it('truncates a folder over the per-upload cap with the picker notice', async () => {
    const children = ['1.jpg', '2.jpg', '3.jpg', '4.jpg', '5.jpg'].map(fileEntry);
    await dropOnZone({
      files: [],
      items: [{ kind: 'file', webkitGetAsEntry: () => dirEntry('shoot', children) }],
    });

    await waitFor(() => expect(toastWarning).toHaveBeenCalledWith('upload.someFilesSkipped:3:3'));
    expect(screen.getByText('3.jpg')).toBeInTheDocument();
    expect(screen.queryByText('4.jpg')).not.toBeInTheDocument();
  });

  it('holds the cap across two drops whose folder walks are still pending', async () => {
    // Both walks resolve against the selection as it is when they land, not
    // as it was when the drop happened; otherwise 2 + 2 files passed a cap of 3.
    const { container } = renderWithClient(<PhotoUpload eventId={1} />);
    await waitFor(() => expect(screen.getByText('upload.videoSizeLimit')).toBeInTheDocument());
    const zone = container.querySelector('input[type="file"]')!.parentElement!;
    const drop = (names: string[]) => fireEvent.drop(zone, {
      dataTransfer: { files: [], items: [{ kind: 'file', webkitGetAsEntry: () => dirEntry('d', names.map(fileEntry)) }] },
    });
    drop(['a1.jpg', 'a2.jpg']);
    drop(['b1.jpg', 'b2.jpg']);

    await waitFor(() => expect(toastWarning).toHaveBeenCalledWith('upload.someFilesSkipped:1:3'));
    await waitFor(() => expect(screen.getByText('b1.jpg')).toBeInTheDocument());
    expect(screen.getByText('a1.jpg')).toBeInTheDocument();
    expect(screen.getByText('a2.jpg')).toBeInTheDocument();
    expect(screen.queryByText('b2.jpg')).not.toBeInTheDocument();
  });

  it('keeps Upload disabled until a pending folder walk has landed', async () => {
    // A reader that only answers once released: the walk is pending until then.
    let release: (() => void) | null = null;
    const slowDir = {
      isFile: false,
      isDirectory: true,
      name: 'slow',
      createReader: () => {
        let done = false;
        return {
          readEntries: (ok: (entries: object[]) => void) => {
            const answer = () => { ok(done ? [] : [fileEntry('late.jpg')]); done = true; };
            if (done) answer(); else release = answer;
          },
        };
      },
    };
    const { container } = renderWithClient(<PhotoUpload eventId={1} />);
    await waitFor(() => expect(screen.getByText('upload.videoSizeLimit')).toBeInTheDocument());
    const zone = container.querySelector('input[type="file"]')!.parentElement!;
    // Already selected files alone would enable the button.
    fireEvent.drop(zone, { dataTransfer: { files: [jpg('early.jpg')] } });
    await waitFor(() => expect(screen.getByText('early.jpg')).toBeInTheDocument());
    const uploadButton = () => screen.getByRole('button', { name: /common\.upload/ });
    expect(uploadButton()).not.toBeDisabled();

    fireEvent.drop(zone, { dataTransfer: { files: [], items: [{ kind: 'file', webkitGetAsEntry: () => slowDir }] } });
    await waitFor(() => expect(uploadButton()).toBeDisabled());

    release!();
    await waitFor(() => expect(screen.getByText('late.jpg')).toBeInTheDocument());
    await waitFor(() => expect(uploadButton()).not.toBeDisabled());
  });

  it('falls back to dataTransfer.files without the entry API', async () => {
    await dropOnZone({ files: [jpg('plain.jpg')] });

    await waitFor(() => expect(screen.getByText('plain.jpg')).toBeInTheDocument());
  });
});
