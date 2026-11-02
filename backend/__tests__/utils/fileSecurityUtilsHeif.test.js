const { normalizeUploadMimeType, validateFileType } = require('../../src/utils/fileSecurityUtils');

describe('badly typed HEIC and HEIF uploads (issue 2359)', () => {
  const heif = ['image/heic', 'image/heif'];

  it.each([
    ['IMG_1.HEIC', '', 'image/heic'],
    ['IMG_1.heic', 'image/heif', 'image/heic'],
    ['IMG_1.HEIC', 'application/octet-stream', 'image/heic'],
    ['IMG_1.heif', 'image/heic', 'image/heif'],
  ])('names %s reported as "%s" from its extension', (name, reported, expected) => {
    expect(normalizeUploadMimeType(name, reported)).toBe(expected);
    expect(validateFileType(name, normalizeUploadMimeType(name, reported), heif)).toBe(true);
  });

  it('needs the type enabled, by its extension', () => {
    expect(validateFileType('IMG_1.HEIC', normalizeUploadMimeType('IMG_1.HEIC', ''), ['image/jpeg'])).toBe(false);
    expect(validateFileType('IMG_1.heif', 'image/heif', ['image/heic'])).toBe(false);
  });

  it('leaves the check itself to the routes that normalise, so a transfer keeps its type', () => {
    expect(validateFileType('IMG_1.HEIC', 'application/octet-stream', [...heif, 'application/octet-stream'])).toBe(false);
  });

  it('does not rename a type that names something else', () => {
    expect(normalizeUploadMimeType('page.heic', 'text/html')).toBe('text/html');
    expect(validateFileType('page.heic', 'text/html', [...heif, 'text/html'])).toBe(false);
    expect(validateFileType('page.html', 'image/heic', heif)).toBe(false);
  });
});
