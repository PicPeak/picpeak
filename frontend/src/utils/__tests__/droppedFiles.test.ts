/**
 * Folder drops on the admin uploader (issue 1733, backlog item C1).
 *
 * jsdom has no DataTransfer or FileSystem entry API, so both are modelled
 * here the way Chrome hands them to a drop handler: `items` carrying
 * `webkitGetAsEntry()`, directory readers that return their children in
 * batches and finish with an empty batch, file entries that resolve the
 * `File` through a callback.
 *
 * Pins:
 *  - nested folders are flattened, children sorted by name per folder
 *  - batched readEntries are drained to the empty batch
 *  - hidden entries inside a folder are skipped
 *  - no `items` / no `webkitGetAsEntry` falls back to `dataTransfer.files`
 */
import { describe, expect, it } from 'vitest';

import { collectDroppedFiles } from '../droppedFiles';

type Entry = FileSystemFileEntry | FileSystemDirectoryEntry;

const fileEntry = (name: string): FileSystemFileEntry =>
  ({
    isFile: true,
    isDirectory: false,
    name,
    file: (ok: (f: File) => void) => ok(new File(['x'], name, { type: 'image/jpeg' })),
  }) as unknown as FileSystemFileEntry;

// `batchSize` splits the children the way a real reader does (Chrome: 100).
const dirEntry = (name: string, children: Entry[], batchSize = 100): FileSystemDirectoryEntry =>
  ({
    isFile: false,
    isDirectory: true,
    name,
    createReader: () => {
      let offset = 0;
      return {
        readEntries: (ok: (entries: FileSystemEntry[]) => void) => {
          const batch = children.slice(offset, offset + batchSize);
          offset += batch.length;
          ok(batch);
        },
      };
    },
  }) as unknown as FileSystemDirectoryEntry;

const dataTransferFrom = (entries: Entry[], files: File[] = []) =>
  ({
    files,
    items: entries.map((entry) => ({ kind: 'file', webkitGetAsEntry: () => entry })),
  }) as unknown as DataTransfer;

describe('collectDroppedFiles', () => {
  it('flattens nested folders, sorted by name within each folder', async () => {
    const dt = dataTransferFrom([
      dirEntry('shoot', [
        fileEntry('IMG_10.jpg'),
        dirEntry('b-portraits', [fileEntry('p2.jpg'), fileEntry('p1.jpg')]),
        fileEntry('IMG_2.jpg'),
        dirEntry('a-ceremony', [fileEntry('c1.jpg')]),
      ]),
    ]);

    const names = (await collectDroppedFiles(dt)).map((f) => f.name);

    // Files and sub-folders share one name sort per folder; numeric
    // collation keeps IMG_2 ahead of IMG_10.
    expect(names).toEqual(['c1.jpg', 'p1.jpg', 'p2.jpg', 'IMG_2.jpg', 'IMG_10.jpg']);
  });

  it('drains batched readEntries until the empty batch', async () => {
    const children = Array.from({ length: 250 }, (_, i) => fileEntry(`f${String(i).padStart(3, '0')}.jpg`));
    const dt = dataTransferFrom([dirEntry('big', children, 100)]);

    const files = await collectDroppedFiles(dt);

    expect(files).toHaveLength(250);
    expect(files[0].name).toBe('f000.jpg');
    expect(files[249].name).toBe('f249.jpg');
  });

  it('skips hidden files and folders inside a dropped folder', async () => {
    const dt = dataTransferFrom([
      dirEntry('shoot', [
        fileEntry('.DS_Store'),
        fileEntry('._IMG_1.jpg'),
        dirEntry('.thumbnails', [fileEntry('t.jpg')]),
        fileEntry('IMG_1.jpg'),
      ]),
    ]);

    expect((await collectDroppedFiles(dt)).map((f) => f.name)).toEqual(['IMG_1.jpg']);
  });

  it('keeps plain files dropped next to a folder, in item order', async () => {
    const dt = dataTransferFrom([fileEntry('z.jpg'), dirEntry('d', [fileEntry('a.jpg')])]);

    expect((await collectDroppedFiles(dt)).map((f) => f.name)).toEqual(['z.jpg', 'a.jpg']);
  });

  it('stops walking once the limit is reached and leaves later folders unread', async () => {
    const reads: string[] = [];
    const countingDir = (name: string, children: Entry[]): FileSystemDirectoryEntry => {
      const inner = dirEntry(name, children);
      const reader = inner.createReader.bind(inner);
      return { ...inner, createReader: () => { reads.push(name); return reader(); } } as unknown as FileSystemDirectoryEntry;
    };
    // 10 files over three folders; a cap of 3 asks for 3 + 1.
    const dt = dataTransferFrom([
      countingDir('a', ['1.jpg', '2.jpg', '3.jpg', '4.jpg', '5.jpg'].map(fileEntry)),
      countingDir('b', ['6.jpg', '7.jpg', '8.jpg'].map(fileEntry)),
      countingDir('c', ['9.jpg', '10.jpg'].map(fileEntry)),
    ]);

    const files = await collectDroppedFiles(dt, 4);

    expect(files.map((f) => f.name)).toEqual(['1.jpg', '2.jpg', '3.jpg', '4.jpg']);
    expect(reads).toEqual(['a']);
  });

  it('falls back to dataTransfer.files without the entry API', async () => {
    const plain = [new File(['x'], 'plain.jpg', { type: 'image/jpeg' })];

    expect(await collectDroppedFiles({ files: plain } as unknown as DataTransfer)).toEqual(plain);
    expect(
      await collectDroppedFiles({ files: plain, items: [{ kind: 'file' }] } as unknown as DataTransfer)
    ).toEqual(plain);
  });
});
