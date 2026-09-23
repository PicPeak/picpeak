'use strict';

// Stored file paths (storedPath.js): relative to the storage root when
// written, and placed on the CURRENT root when read — whichever root an
// absolute legacy value was recorded under — without ever leaving it.

const fs = require('fs');
const os = require('os');
const path = require('path');

let tmp;
let root;
let otherRoot;
const prevStorage = process.env.STORAGE_PATH;
const prevCwd = process.cwd();

const { toStoredPath, relocateStoredPath, resolveStoredPath } = require('../../src/utils/storedPath');
const { assertContractPdfPath, assertStoredPathInside, resolveStoredPathStrict } = require('../../src/utils/safePath');

function put(base, rel, content = 'x') {
  const file = path.join(base, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stored-path-')));
  root = path.join(tmp, 'now', 'storage');
  otherRoot = path.join(tmp, 'app', 'storage');
  fs.mkdirSync(root, { recursive: true });
  process.env.STORAGE_PATH = root;
  process.chdir(tmp);
});

afterEach(() => {
  process.chdir(prevCwd);
  if (prevStorage === undefined) delete process.env.STORAGE_PATH;
  else process.env.STORAGE_PATH = prevStorage;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('toStoredPath', () => {
  it('records a file under the storage root relative to it, with forward slashes', () => {
    expect(toStoredPath(path.join(root, 'business-docs', 'contract', '2026', 'C-1.pdf')))
      .toBe('business-docs/contract/2026/C-1.pdf');
  });

  it('leaves a path outside the root, a relative path and empty values alone', () => {
    expect(toStoredPath('/elsewhere/business-docs/x.pdf')).toBe('/elsewhere/business-docs/x.pdf');
    expect(toStoredPath(`${root}-evil/business-docs/x.pdf`)).toBe(`${root}-evil/business-docs/x.pdf`);
    expect(toStoredPath('business-docs/x.pdf')).toBe('business-docs/x.pdf');
    expect(toStoredPath(null)).toBeNull();
  });

  it('records a working-directory-relative writer path (relative STORAGE_PATH) relative to the root', () => {
    process.env.STORAGE_PATH = './now/storage';
    expect(toStoredPath('now/storage/business-docs/contract/2026/C-1.pdf')).toBe('business-docs/contract/2026/C-1.pdf');
  });
});

describe('resolveStoredPath', () => {
  it('finds a row recorded relative to the working directory under a relative STORAGE_PATH', () => {
    const file = put(root, 'business-docs/contract/2026/C-1.pdf');
    expect(resolveStoredPath('now/storage/business-docs/contract/2026/C-1.pdf')).toBe(file);
    process.env.STORAGE_PATH = './now/storage';
    expect(resolveStoredPath('now/storage/business-docs/contract/2026/C-1.pdf')).toBe(file);
    // Only when that file exists and lands inside a storage root.
    put(tmp, 'secret/x.pdf');
    expect(resolveStoredPath('secret/x.pdf')).toBe(path.join(root, 'secret', 'x.pdf'));
    expect(resolveStoredPath('../../secret/x.pdf')).toBeNull();
  });

  it('joins a relative value onto the current root', () => {
    expect(resolveStoredPath('business-docs/quote/2026/Q-1.pdf')).toBe(path.join(root, 'business-docs', 'quote', '2026', 'Q-1.pdf'));
  });

  it('keeps an absolute value under the current root', () => {
    const file = put(root, 'business-docs/invoice/2026/I-1.pdf');
    expect(resolveStoredPath(file)).toBe(file);
  });

  it('maps an absolute value recorded under another root onto the current one', () => {
    const here = put(root, 'business-docs/contract/2026/C-1_signed.pdf', 'signed');
    const legacy = path.join(otherRoot, 'business-docs', 'contract', '2026', 'C-1_signed.pdf');
    expect(resolveStoredPath(legacy)).toBe(here);
    expect(resolveStoredPath('/app/storage/uploads/contracts/signed/wet.pdf'))
      .toBe(path.join(root, 'uploads', 'contracts', 'signed', 'wet.pdf'));
  });

  it('picks the storage folder whose file exists when a path has more than one', () => {
    // The old root itself sat below a directory called "uploads".
    const here = put(root, 'business-docs/contract/2026/C-2.pdf');
    expect(resolveStoredPath('/srv/uploads/picpeak/storage/business-docs/contract/2026/C-2.pdf')).toBe(here);
    const upload = put(root, 'uploads/contracts/signed/C-3.pdf');
    expect(resolveStoredPath('/home/x/business-docs/old/storage/uploads/contracts/signed/C-3.pdf')).toBe(upload);
  });

  it('refuses values that climb out of the root or name no storage folder', () => {
    expect(resolveStoredPath('../../etc/passwd')).toBeNull();
    expect(resolveStoredPath('business-docs/../../secret')).toBeNull();
    expect(resolveStoredPath('/etc/passwd')).toBeNull();
    expect(resolveStoredPath('/app/storage/business-docs/../../../etc/passwd')).toBeNull();
    expect(resolveStoredPath('')).toBeNull();
    expect(resolveStoredPath(null)).toBeNull();
  });

  it('keeps a file under <cwd>/storage, the root the contract writers used before', () => {
    const legacy = put(path.join(tmp, 'storage'), 'business-docs/contract/2025/C-0.pdf');
    expect(resolveStoredPath(legacy)).toBe(legacy);
    // Even when the current root has a same-named (possibly different) file.
    put(root, 'business-docs/contract/2025/C-0.pdf', 'other');
    expect(resolveStoredPath(legacy)).toBe(legacy);
  });
});

describe('relocateStoredPath (restore)', () => {
  it('rewrites another install’s absolute path to its storage-relative part', () => {
    expect(relocateStoredPath('/app/storage/business-docs/contract/2026/C-1.pdf')).toBe('business-docs/contract/2026/C-1.pdf');
    expect(relocateStoredPath(path.join(root, 'uploads', 'logos', 'events', 'l.png'))).toBe('uploads/logos/events/l.png');
  });

  it('asks the archive which candidate it carries', () => {
    const value = '/srv/uploads/storage/business-docs/a.pdf';
    expect(relocateStoredPath(value)).toBe('business-docs/a.pdf');
    expect(relocateStoredPath(value, (rel) => rel === 'uploads/storage/business-docs/a.pdf'))
      .toBe('uploads/storage/business-docs/a.pdf');
  });

  it('prefers the archive’s suffix when the source root sits inside this root', () => {
    process.env.STORAGE_PATH = tmp;
    const value = path.join(tmp, 'storage', 'business-docs', 'a.pdf');
    expect(relocateStoredPath(value, (rel) => rel === 'business-docs/a.pdf')).toBe('business-docs/a.pdf');
    expect(relocateStoredPath(value, (rel) => rel === 'storage/business-docs/a.pdf')).toBe('storage/business-docs/a.pdf');
  });

  it('keeps a legacy-root path whose file is still there, whatever the archive carries', () => {
    const legacy = put(path.join(tmp, 'storage'), 'business-docs/quote/2026/Q-1.pdf');
    expect(relocateStoredPath(legacy, () => true)).toBe(legacy);
  });

  it('keeps the value when the archive carries none of its candidates', () => {
    const legacy = path.join(tmp, 'storage', 'business-docs', 'contract', '2026', 'C-1.pdf');
    expect(relocateStoredPath(legacy, () => false)).toBe(legacy);
  });

  it('rewrites another install’s working-directory-relative path', () => {
    expect(relocateStoredPath('storage/business-docs/a.pdf')).toBe('business-docs/a.pdf');
    expect(relocateStoredPath('storage/business-docs/a.pdf', (rel) => rel === 'business-docs/a.pdf')).toBe('business-docs/a.pdf');
  });

  it('leaves relative, foreign and empty values as they are', () => {
    expect(relocateStoredPath('business-docs/a.pdf')).toBe('business-docs/a.pdf');
    expect(relocateStoredPath('/etc/passwd')).toBe('/etc/passwd');
    expect(relocateStoredPath(null)).toBeNull();
  });
});

describe('read guards', () => {
  it('serves a relative and a foreign-root contract path from the current root', () => {
    const file = put(root, 'business-docs/contract/2026/C-1.pdf');
    expect(assertContractPdfPath('business-docs/contract/2026/C-1.pdf')).toBe(file);
    expect(assertContractPdfPath(path.join(otherRoot, 'business-docs', 'contract', '2026', 'C-1.pdf'))).toBe(file);
  });

  it('refuses a stored path outside the storage roots with 403', () => {
    put(root, 'business-docs/contract/2026/C-1.pdf');
    for (const bad of ['../../etc/passwd', '/etc/passwd', 'business-docs/invoice/../../../etc/hosts']) {
      expect(() => assertContractPdfPath(bad)).toThrow(expect.objectContaining({ statusCode: 403 }));
    }
    // Inside the storage root but outside the contract folders.
    put(root, 'business-docs/invoice/2026/I-1.pdf');
    expect(() => assertContractPdfPath('business-docs/invoice/2026/I-1.pdf')).toThrow(expect.objectContaining({ statusCode: 403 }));
  });

  it('resolveStoredPathStrict: the realpath, null when missing, 403 outside or linked out', () => {
    const file = put(root, 'business-docs/invoice/2026/I-1.pdf');
    expect(resolveStoredPathStrict('business-docs/invoice/2026/I-1.pdf')).toBe(fs.realpathSync(file));
    expect(resolveStoredPathStrict('/app/storage/business-docs/invoice/2026/I-1.pdf')).toBe(fs.realpathSync(file));
    expect(resolveStoredPathStrict('business-docs/invoice/2026/gone.pdf')).toBeNull();
    expect(resolveStoredPathStrict(null)).toBeNull();
    const outside = put(tmp, 'outside/secret.pdf');
    fs.symlinkSync(outside, path.join(root, 'business-docs', 'invoice', '2026', 'link.pdf'));
    for (const bad of ['/etc/passwd', '../../etc/passwd', 'business-docs/invoice/2026/link.pdf']) {
      expect(() => resolveStoredPathStrict(bad)).toThrow(expect.objectContaining({ statusCode: 403 }));
    }
    // Confined to one folder, a file elsewhere in storage is refused too.
    fs.mkdirSync(path.join(root, 'business-docs', 'quote'), { recursive: true });
    expect(() => resolveStoredPathStrict('business-docs/invoice/2026/I-1.pdf', [path.join(root, 'business-docs', 'quote')]))
      .toThrow(expect.objectContaining({ statusCode: 403 }));
  });

  it('assertStoredPathInside follows symlinks out of the root', () => {
    const outside = put(tmp, 'outside/secret.pdf');
    fs.mkdirSync(path.join(root, 'business-docs'), { recursive: true });
    fs.symlinkSync(outside, path.join(root, 'business-docs', 'link.pdf'));
    expect(() => assertStoredPathInside('business-docs/link.pdf', [path.join(root, 'business-docs')]))
      .toThrow(expect.objectContaining({ statusCode: 403 }));
  });
});
