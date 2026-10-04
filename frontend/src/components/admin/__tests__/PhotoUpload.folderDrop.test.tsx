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

  it('keeps files read before the settings resolved when the resolved limits allow them', async () => {
    // The whole walk finishes while admin-settings is still loading: under
    // the defaults the video (type) and the 60 MB image (size) would be
    // dropped during the walk, with nothing left for addFiles to recover.
    let releaseSettings: (() => void) | null = null;
    settingsMock.mockImplementation(() => new Promise((ok) => {
      releaseSettings = () => ok({
        ...DEFAULT_SETTINGS,
        general_allowed_file_types: 'jpg,mp4',
        general_max_file_size_mb: 100,
      });
    }));
    const sized = (name: string, type: string, mb: number) => {
      const file = new File(['x'], name, { type });
      Object.defineProperty(file, 'size', { value: mb * 1024 * 1024 });
      return { isFile: true, isDirectory: false, name, file: (ok: (f: File) => void) => ok(file) };
    };
    // The walk waits on its last file, so addFiles runs after the settings.
    let releaseLast: (() => void) | null = null;
    const last = {
      isFile: true, isDirectory: false, name: 'z.jpg',
      file: (ok: (f: File) => void) => { releaseLast = () => ok(jpg('z.jpg')); },
    };
    const { container } = renderWithClient(<PhotoUpload eventId={1} />);
    const zone = container.querySelector('input[type="file"]')!.parentElement!;
    fireEvent.drop(zone, {
      dataTransfer: {
        files: [],
        items: [{ kind: 'file', webkitGetAsEntry: () => dirEntry('mixed', [sized('big.jpg', 'image/jpeg', 60), sized('clip.mp4', 'video/mp4', 1), last]) }],
      },
    });
    // big.jpg and clip.mp4 have been read by now, under the default limits.
    await waitFor(() => expect(releaseLast).not.toBeNull());

    releaseSettings!();
    await waitFor(() => expect(screen.getByText('upload.videoSizeLimit')).toBeInTheDocument());
    releaseLast!();

    await waitFor(() => expect(screen.getByText('z.jpg')).toBeInTheDocument());
    expect(screen.getByText('big.jpg')).toBeInTheDocument();
    expect(screen.getByText('clip.mp4')).toBeInTheDocument();
    expect(toastError).not.toHaveBeenCalled();
  });

  it('holds a walk that finished before the settings settled and admits it afterwards', async () => {
    // Nothing delays the walk here: it is done while admin-settings is still
    // loading, and admitting it then would judge by the defaults for good.
    let releaseSettings: (() => void) | null = null;
    settingsMock.mockImplementation(() => new Promise((ok) => {
      releaseSettings = () => ok({
        ...DEFAULT_SETTINGS,
        general_allowed_file_types: 'jpg,mp4',
        general_max_file_size_mb: 100,
      });
    }));
    const sized = (name: string, type: string, mb: number) => {
      const file = new File(['x'], name, { type });
      Object.defineProperty(file, 'size', { value: mb * 1024 * 1024 });
      return { isFile: true, isDirectory: false, name, file: (ok: (f: File) => void) => ok(file) };
    };
    const { container } = renderWithClient(<PhotoUpload eventId={1} />);
    const zone = container.querySelector('input[type="file"]')!.parentElement!;
    fireEvent.drop(zone, {
      dataTransfer: {
        files: [],
        items: [{ kind: 'file', webkitGetAsEntry: () => dirEntry('mixed', [sized('big.jpg', 'image/jpeg', 60), sized('clip.mp4', 'video/mp4', 1)]) }],
      },
    });
    // Let the walk run to its end; nothing is selected or refused yet.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByText('big.jpg')).not.toBeInTheDocument();
    expect(toastError).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /common\.upload/ })).toBeDisabled();

    releaseSettings!();

    await waitFor(() => expect(screen.getByText('clip.mp4')).toBeInTheDocument());
    expect(screen.getByText('big.jpg')).toBeInTheDocument();
    expect(toastError).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole('button', { name: /common\.upload/ })).not.toBeDisabled());
  });

  it('says so when a folder is too large to scan completely', async () => {
    // More unsupported files than the examined budget (five times the walk
    // ceiling of 2001) before the one photo at the end of the tree.
    const txt = (name: string) => ({
      isFile: true, isDirectory: false, name,
      file: (ok: (f: File) => void) => ok(new File(['x'], name, { type: 'text/plain' })),
    });
    const notes = Array.from({ length: 10010 }, (_, i) => txt(`n${i}.txt`));
    await dropOnZone({
      files: [],
      items: [
        { kind: 'file', webkitGetAsEntry: () => dirEntry('notes', notes) },
        { kind: 'file', webkitGetAsEntry: () => dirEntry('photos', [fileEntry('unreached.jpg')]) },
      ],
    });

    await waitFor(() => expect(toastWarning).toHaveBeenCalledWith('upload.folderTooLarge'), { timeout: 10000 });
    expect(toastWarning).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('unreached.jpg')).not.toBeInTheDocument();
  }, 20000);

  it('reports an oversized file in a folder once', async () => {
    const big = new File(['x'], 'huge.jpg', { type: 'image/jpeg' });
    Object.defineProperty(big, 'size', { value: 60 * 1024 * 1024 });
    await dropOnZone({
      files: [],
      items: [{ kind: 'file', webkitGetAsEntry: () => dirEntry('d', [
        { isFile: true, isDirectory: false, name: 'huge.jpg', file: (ok: (f: File) => void) => ok(big) },
        fileEntry('ok.jpg'),
      ]) }],
    });

    await waitFor(() => expect(screen.getByText('ok.jpg')).toBeInTheDocument());
    expect(screen.queryByText('huge.jpg')).not.toBeInTheDocument();
    expect(toastError).toHaveBeenCalledTimes(1);
  });

  it('applies the cap as it is when the walk lands, not as it was at the drop', async () => {
    // Cap 3, three files selected: no capacity at drop time. Two are removed
    // while the folder is still being walked, so both of its files must fit.
    let release: (() => void) | null = null;
    const slowDir = {
      isFile: false, isDirectory: true, name: 'slow',
      createReader: () => {
        let done = false;
        return {
          readEntries: (ok: (entries: object[]) => void) => {
            const answer = () => { ok(done ? [] : [fileEntry('late1.jpg'), fileEntry('late2.jpg')]); done = true; };
            if (done) answer(); else release = answer;
          },
        };
      },
    };
    const { container } = renderWithClient(<PhotoUpload eventId={1} />);
    await waitFor(() => expect(screen.getByText('upload.videoSizeLimit')).toBeInTheDocument());
    const zone = container.querySelector('input[type="file"]')!.parentElement!;
    fireEvent.drop(zone, { dataTransfer: { files: [jpg('e1.jpg'), jpg('e2.jpg'), jpg('e3.jpg')] } });
    await waitFor(() => expect(screen.getByText('e3.jpg')).toBeInTheDocument());

    fireEvent.drop(zone, { dataTransfer: { files: [], items: [{ kind: 'file', webkitGetAsEntry: () => slowDir }] } });
    const removeButton = (name: string) =>
      screen.getByText(name).closest('.justify-between')!.querySelector('button')!;
    fireEvent.click(removeButton('e3.jpg'));
    fireEvent.click(removeButton('e2.jpg'));
    release!();

    await waitFor(() => expect(screen.getByText('late2.jpg')).toBeInTheDocument());
    expect(screen.getByText('late1.jpg')).toBeInTheDocument();
    expect(toastWarning).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });

  it('truncates a tree over the cap across folders and raises the skipped notice', async () => {
    await dropOnZone({
      files: [],
      items: [
        { kind: 'file', webkitGetAsEntry: () => dirEntry('first', ['1.jpg', '2.jpg'].map(fileEntry)) },
        { kind: 'file', webkitGetAsEntry: () => dirEntry('second', ['3.jpg', '4.jpg', '5.jpg'].map(fileEntry)) },
      ],
    });

    await waitFor(() => expect(toastWarning).toHaveBeenCalledWith('upload.someFilesSkipped:3:3'));
    expect(screen.getByText('3.jpg')).toBeInTheDocument();
    expect(screen.queryByText('4.jpg')).not.toBeInTheDocument();
  });

  it('keeps every JPEG up to the cap when sidecars sit between them', async () => {
    const xmp = (name: string) => ({
      isFile: true, isDirectory: false, name,
      file: (ok: (f: File) => void) => ok(new File(['x'], name, { type: 'application/xml' })),
    });
    await dropOnZone({
      files: [],
      items: [{ kind: 'file', webkitGetAsEntry: () => dirEntry('raw', [xmp('1.xmp'), fileEntry('1.jpg'), xmp('2.xmp'), fileEntry('2.jpg'), xmp('3.xmp'), fileEntry('3.jpg')]) }],
    });

    await waitFor(() => expect(screen.getByText('3.jpg')).toBeInTheDocument());
    expect(screen.getByText('1.jpg')).toBeInTheDocument();
    expect(screen.getByText('2.jpg')).toBeInTheDocument();
    expect(toastWarning).not.toHaveBeenCalled();
  });

  it('falls back to dataTransfer.files without the entry API', async () => {
    await dropOnZone({ files: [jpg('plain.jpg')] });

    await waitFor(() => expect(screen.getByText('plain.jpg')).toBeInTheDocument());
  });
});
