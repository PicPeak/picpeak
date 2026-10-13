/**
 * Folder uploads on the admin uploader (issues 1786 + 1562).
 *
 * Pins:
 *  - a folder pick shows the structure preview from a dry-run resolve, with
 *    "Keep folder structure" defaulting to the event's setting
 *  - Upload resolves for real, then sends one multipart batch per placement
 *    carrying folder_id / folder_request_id / first_look (and the filter
 *    category on every batch)
 *  - an upload-only role sees the folder-request notice and label
 *  - the chunked complete body carries the same placement fields
 */
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PhotoUpload } from '../PhotoUpload';
import { renderWithUploadSession } from './uploadTestUtils';
import { appendUploadPlacement, photosService, uploadPlacementBody } from '../../../services/photos.service';
import type { ResolveResponse } from '../../../services/folders.service';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
  };
});

vi.mock('react-toastify', () => ({
  toast: { warning: vi.fn(), info: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

const { postMock, getMock } = vi.hoisted(() => ({ postMock: vi.fn(), getMock: vi.fn() }));
vi.mock('../../../config/api', () => ({ api: { post: postMock, get: getMock } }));

vi.mock('../../../hooks/useUploadProgress', () => ({
  useUploadProgress: () => ({
    snapshots: {},
    error: null,
    aggregate: { total: 0, pending: 0, processing: 0, complete: 0, failed: 0, failedPhotos: [], isComplete: false, isReady: true },
  }),
}));

vi.mock('../../../services/categories.service', () => ({
  categoriesService: {
    getEventCategories: vi.fn().mockResolvedValue([
      { id: 5, name: 'Portraits', slug: 'portraits', is_global: false, event_id: 7, created_at: '' },
      { id: 11, name: 'Friday', slug: 'friday', is_global: false, event_id: 7, is_folder: true, created_at: '' },
    ]),
  },
}));
vi.mock('../../../services/settings.service', () => ({
  settingsService: {
    getAllSettings: vi.fn().mockResolvedValue({ general_allowed_file_types: 'jpg,jpeg', general_max_files_per_upload: 50 }),
  },
}));

const inFolder = (relativePath: string) => {
  const file = new File(['x'], relativePath.split('/').pop()!, { type: 'image/jpeg' });
  Object.defineProperty(file, 'webkitRelativePath', { value: relativePath });
  return file;
};

const resolveAnswer = (canManage: boolean, dryRun: boolean): ResolveResponse => ({
  can_manage: canManage,
  single_root: 'Export',
  max_depth: 3,
  results: {
    Export: { segments: [], first_look: false, folder_id: null, status: 'root' },
    'Export/Friday': { segments: ['Friday'], first_look: false, folder_id: 11, status: 'exists' },
    'Export/Saturday': canManage
      ? { segments: ['Saturday'], first_look: false, folder_id: dryRun ? null : 12, status: dryRun ? 'new' : 'created' }
      : { segments: ['Saturday'], first_look: false, folder_id: null, status: dryRun ? 'needs_admin' : 'requested', ...(dryRun ? {} : { folder_request_id: 3 }) },
    'Export/FirstLook': { segments: [], first_look: true, folder_id: null, status: 'root' },
  },
  nodes: {
    Friday: 'exists',
    Saturday: canManage ? (dryRun ? 'new' : 'created') : (dryRun ? 'needs_admin' : 'requested'),
  },
});

const setup = (canManage: boolean, limit: ResolveResponse['limit'] = null) => {
  getMock.mockImplementation((url: string) =>
    Promise.resolve({
      data: url.endsWith('/folders')
        ? { folders: [{ id: 11, name: 'Friday', slug: 'friday', parent_id: null, source_path: 'Friday', hero_photo_id: null, allow_downloads: true, photo_count: 0 }], requests: [], can_manage: canManage, max_depth: 3 }
        : {},
    })
  );
  postMock.mockImplementation((url: string, body: { dry_run?: boolean }) => {
    if (url.endsWith('/folders/resolve')) {
      const dryRun = body.dry_run === true;
      return Promise.resolve({ data: { ...resolveAnswer(canManage, dryRun), limit: dryRun ? limit : undefined } });
    }
    return Promise.resolve({ data: { count: 1, upload_id: `u${postMock.mock.calls.length}`, errors: [] } });
  });
};

const pickFolder = async (container: HTMLElement) => {
  const user = userEvent.setup();
  await waitFor(() => expect(screen.getByText('upload.fileRequirements')).toBeInTheDocument());
  const folderInput = container.querySelector('[data-testid="folder-input"]') as HTMLInputElement;
  expect(folderInput.hasAttribute('webkitdirectory')).toBe(true);
  await user.upload(folderInput, [
    inFolder('Export/loose.jpg'),
    inFolder('Export/Friday/f1.jpg'),
    inFolder('Export/Friday/f2.jpg'),
    inFolder('Export/Saturday/s1.jpg'),
    inFolder('Export/FirstLook/fl1.jpg'),
  ]);
  return user;
};

const uploads = () => postMock.mock.calls.filter(([url]) => String(url).endsWith('/upload'));
const resolves = () => postMock.mock.calls.filter(([url]) => String(url).endsWith('/folders/resolve'));

describe('PhotoUpload folder structure', () => {
  beforeEach(() => {
    postMock.mockReset();
    getMock.mockReset();
  });

  it('says before the upload when it would go past the folder limit, and holds the button', async () => {
    setup(true, { code: 'FOLDER_LIMIT_REACHED', limit: 1000, current: 1000, adding: 1 });
    const { container } = renderWithUploadSession(<PhotoUpload eventId={7} folderStructureDefault />);
    const user = await pickFolder(container);
    await waitFor(() => expect(screen.getByText('upload.structure.overFolderLimit')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'upload.structure.uploadIntoFolders' })).toBeDisabled();

    // Without the structure everything lands in one place: no new folders, no hold.
    await user.click(screen.getByRole('switch'));
    await waitFor(() => expect(screen.queryByText('upload.structure.overFolderLimit')).not.toBeInTheDocument());
    expect(uploads()).toHaveLength(0);
  });

  it('previews the structure, then uploads one batch per placement', async () => {
    setup(true);
    const { container } = renderWithUploadSession(<PhotoUpload eventId={7} folderStructureDefault />);
    const user = await pickFolder(container);

    // Dry run → preview.
    await waitFor(() => expect(screen.getByTestId('upload-structure-preview')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('Saturday')).toBeInTheDocument());
    expect(screen.getByRole('switch')).toBeChecked();
    expect(screen.getByText('upload.structure.statusNew')).toBeInTheDocument();
    expect(screen.getByText('upload.structure.firstLookCallout')).toBeInTheDocument();
    expect(resolves()[0][1]).toMatchObject({ dry_run: true, skip_outer: true, keep_structure: true });
    expect(resolves()[0][1].paths).toEqual(['Export', 'Export/FirstLook', 'Export/Friday', 'Export/Saturday']);

    // Folders are not filter categories: the category select only lists Portraits.
    const categorySelect = screen.getByRole('option', { name: /Portraits/ }).closest('select') as HTMLSelectElement;
    expect([...categorySelect.options].map((o) => o.textContent)).not.toContainEqual(expect.stringContaining('Friday'));
    await user.selectOptions(categorySelect, '5');

    await user.click(screen.getByRole('button', { name: 'upload.structure.uploadIntoFolders' }));

    await waitFor(() => expect(uploads()).toHaveLength(4));
    expect(resolves()[1][1]).toMatchObject({ dry_run: false });
    const sent = uploads().map(([, form]) => {
      const fd = form as FormData;
      return {
        files: fd.getAll('photos').map((f) => (f as File).name),
        category: fd.get('category_id'),
        folder: fd.get('folder_id'),
        request: fd.get('folder_request_id'),
        firstLook: fd.get('first_look'),
      };
    });
    // In the order of the pick, which is sorted by name level by level.
    expect(sent).toEqual([
      { files: ['fl1.jpg'], category: '5', folder: null, request: null, firstLook: 'true' },
      { files: ['f1.jpg', 'f2.jpg'], category: '5', folder: '11', request: null, firstLook: null },
      { files: ['loose.jpg'], category: '5', folder: null, request: null, firstLook: null },
      { files: ['s1.jpg'], category: '5', folder: '12', request: null, firstLook: null },
    ]);
  });

  it('tells an upload-only role its missing folders become requests', async () => {
    setup(false);
    const { container } = renderWithUploadSession(<PhotoUpload eventId={7} folderStructureDefault />);
    const user = await pickFolder(container);

    await waitFor(() => expect(screen.getByText('upload.structure.needsAdminNotice')).toBeInTheDocument());
    expect(screen.getByText('upload.structure.statusNeedsAdmin')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'upload.structure.uploadRequesting' }));

    await waitFor(() => expect(uploads()).toHaveLength(4));
    const requested = uploads().map(([, form]) => (form as FormData).get('folder_request_id'));
    expect(requested).toContain('3');
  });

  it('keeps the structure off when the event says so, sending everything flat', async () => {
    setup(true);
    const { container } = renderWithUploadSession(<PhotoUpload eventId={7} />);
    await pickFolder(container);

    await waitFor(() => expect(resolves().length).toBeGreaterThan(0));
    expect(screen.getByRole('switch')).not.toBeChecked();
    expect(resolves()[0][1]).toMatchObject({ keep_structure: false });
  });
});

describe('upload placement fields', () => {
  it('appends only the fields that are set to a multipart batch', () => {
    const fd = new FormData();
    appendUploadPlacement(fd, { categoryId: 5, folderId: 11, folderRequestId: 3, firstLook: true });
    expect([...fd.entries()]).toEqual([
      ['category_id', '5'],
      ['folder_id', '11'],
      ['folder_request_id', '3'],
      ['first_look', 'true'],
    ]);

    const plain = new FormData();
    appendUploadPlacement(plain, { categoryId: null, folderId: null });
    expect([...plain.entries()]).toEqual([]);
  });

  it('builds the chunked complete body, unchanged for a plain upload', async () => {
    expect(uploadPlacementBody({ categoryId: null })).toEqual({ category_id: null });
    expect(uploadPlacementBody({ categoryId: 5, folderId: 11, firstLook: true })).toEqual({
      category_id: 5, folder_id: 11, first_look: true,
    });

    postMock.mockReset();
    postMock.mockResolvedValue({ data: { success: true, uploaded: 1, photos: [] } });
    await photosService.completeChunkedUpload(7, 'up1', 5, { folderRequestId: 3 });
    expect(postMock).toHaveBeenCalledWith(
      '/admin/photos/7/chunked-upload/up1/complete',
      { category_id: 5, folder_request_id: 3 },
      { timeout: 0 }
    );
  });
});
