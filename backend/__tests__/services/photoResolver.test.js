const path = require('path');
const mockPath = path;

jest.mock('../../src/services/externalMediaService', () => ({
  resolveExternalPath: jest.fn((event, relPath) => mockPath.join('/mock/external', event.external_path || '', relPath || '')),
}));

const { resolveExternalPath } = require('../../src/services/externalMediaService');
const { resolvePhotoFilePath } = require('../../src/services/photoResolver');

describe('resolvePhotoFilePath', () => {
  const backendRoot = path.resolve(__dirname, '../../');
  const originalStoragePath = process.env.STORAGE_PATH;

  beforeEach(() => {
    process.env.STORAGE_PATH = path.join(backendRoot, 'storage');
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  afterAll(() => {
    if (typeof originalStoragePath === 'string') {
      process.env.STORAGE_PATH = originalStoragePath;
    } else {
      delete process.env.STORAGE_PATH;
    }
  });

  it('returns absolute path for managed photos with legacy slug paths', () => {
    const event = { slug: 'wedding-party', source_mode: 'managed' };
    const photo = { path: 'wedding-party/hero.jpg' };

    const result = resolvePhotoFilePath(event, photo);

    expect(result).toBe(path.join(backendRoot, 'storage', 'events/active', 'wedding-party', 'hero.jpg'));
  });

  it('normalizes prefixed managed paths without duplicating segments', () => {
    const event = { slug: 'wedding-party', source_mode: 'managed' };
    const photo = { path: 'events/active/wedding-party/hero.jpg' };

    const result = resolvePhotoFilePath(event, photo);

    expect(result).toBe(path.join(backendRoot, 'storage', 'events/active', 'wedding-party', 'hero.jpg'));
  });

  it('delegates external photos to external media resolver', () => {
    const event = { slug: 'fashion-show', source_mode: 'reference', external_path: 'picsum-demo' };
    const photo = { source_origin: 'external', external_relpath: 'individual/look-01.jpg' };

    const result = resolvePhotoFilePath(event, photo);

    expect(resolveExternalPath).toHaveBeenCalledWith(event, 'individual/look-01.jpg');
    expect(result).toBe(path.join('/mock/external', 'picsum-demo', 'individual', 'look-01.jpg'));
  });

  it('deduplicates folder names when event external path already ends with segment', () => {
    const event = { slug: 'fashion-show', source_mode: 'reference', external_path: 'picsum-demo/individual' };
    const photo = { source_origin: 'external', external_relpath: 'individual/look-02.jpg' };

    const result = resolvePhotoFilePath(event, photo);

    expect(resolveExternalPath).toHaveBeenCalledWith(event, 'look-02.jpg');
    expect(result).toBe(path.join('/mock/external', 'picsum-demo/individual', 'look-02.jpg'));
  });

  it('falls back to managed storage when external metadata is missing', () => {
    const event = { slug: 'fashion-show', source_mode: 'reference', external_path: 'picsum-demo' };
    const photo = { path: 'fashion-show/new-upload.jpg' };

    const result = resolvePhotoFilePath(event, photo);

    expect(resolveExternalPath).not.toHaveBeenCalled();
    expect(result).toBe(path.join(backendRoot, 'storage', 'events/active', 'fashion-show', 'new-upload.jpg'));
  });

  it('throws when external photo is missing relative path data', () => {
    const event = { slug: 'fashion-show', source_mode: 'reference', external_path: 'picsum-demo' };
    const photo = { source_origin: 'external' };

    expect(() => resolvePhotoFilePath(event, photo)).toThrow('Missing external_relpath for external photo');
  });
});
