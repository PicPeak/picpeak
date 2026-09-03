/**
 * Containment for the two admin-writable "delete the old file" paths.
 *
 * Settings → Branding persists logo_url / favicon_url verbatim and, on
 * clear, unlinked `path.join(storage, url)` after a mere prefix check.
 * Business profile did the same for logo_path behind a `/pdf-logo-\d+\./`
 * marker. Both let an admin delete any file the process can reach. The
 * helpers below only ever name a flat leaf inside the fixed directory.
 */
const path = require('path');
const { uploadedAssetPath, uploadedPdfLogoPath } = require('../../src/utils/safePath');

const root = '/srv/picpeak/storage';

describe('uploadedAssetPath', () => {
  it('resolves a flat leaf inside the named upload directory', () => {
    expect(uploadedAssetPath('/uploads/logos/logo-1.png', 'logos', root))
      .toBe(path.join(root, 'uploads', 'logos', 'logo-1.png'));
    expect(uploadedAssetPath('/uploads/favicons/fav.ico', 'favicons', root))
      .toBe(path.join(root, 'uploads', 'favicons', 'fav.ico'));
  });

  it.each([
    '/uploads/logos/../../../data/picpeak.db',
    '/uploads/logos/..',
    '/uploads/logos/',
    '/uploads/logos/sub/dir.png',
    '/uploads/favicons/x.ico', // wrong kind
    'uploads/logos/logo.png', // not /-rooted
    'https://example.com/uploads/logos/logo.png',
    '',
    null,
    42,
  ])('refuses %p', (value) => {
    expect(uploadedAssetPath(value, 'logos', root)).toBeNull();
  });
});

describe('uploadedPdfLogoPath', () => {
  it('resolves the file the upload route writes', () => {
    expect(uploadedPdfLogoPath('/uploads/logos/pdf-logo-1700000000000.png', root))
      .toBe(path.join(root, 'uploads', 'logos', 'pdf-logo-1700000000000.png'));
    expect(uploadedPdfLogoPath('uploads/logos/pdf-logo-1.svg', root))
      .toBe(path.join(root, 'uploads', 'logos', 'pdf-logo-1.svg'));
  });

  it.each([
    'pdf-logo-1./../../../../etc/target',
    '/uploads/logos/pdf-logo-1./../../secret',
    '/etc/pdf-logo-1.x',
    '/uploads/logos/pdf-logo-1.png/../other',
    '/uploads/logos/other-logo.png',
    '/uploads/contracts/signed/pdf-logo-1.pdf',
    '',
    null,
  ])('refuses %p', (value) => {
    expect(uploadedPdfLogoPath(value, root)).toBeNull();
  });
});
