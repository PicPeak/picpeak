/**
 * photos.mime_type is client-influenced (chunked uploads stored the declared
 * type verbatim; the S3 importer stores whatever mime-types derives). Every
 * serving route must go through resolvePhotoContentType so the header is
 * always image/* or video/* and never the stored value as given.
 */
const fs = require('fs');
const path = require('path');
const { resolvePhotoContentType } = require('../../src/utils/photoContentType');

describe('resolvePhotoContentType', () => {
  it('never echoes a non-media stored MIME', () => {
    expect(resolvePhotoContentType({ filename: 'a.jpg', mime_type: 'text/html' })).toBe('image/jpeg');
    expect(resolvePhotoContentType({ filename: 'a', mime_type: 'text/html' })).toBe('image/jpeg');
    expect(resolvePhotoContentType({ filename: 'a.gif', mime_type: 'application/javascript' })).toBe('image/gif');
  });

  it('never honours the scriptable svg / xml family or header-invalid values', () => {
    expect(resolvePhotoContentType({ filename: 'a', mime_type: 'image/svg+xml' })).toBe('image/jpeg');
    expect(resolvePhotoContentType({ filename: 'a', mime_type: 'image/x\r\nX-Injected: 1' })).toBe('image/jpeg');
    expect(resolvePhotoContentType({ filename: 'a.mp4', mime_type: 'video/mp4\r\nX: y' })).toBe('video/mp4');
  });

  it('prefers the mapped extension for images and the stored type for videos', () => {
    expect(resolvePhotoContentType({ filename: 'a.png', mime_type: 'image/jpeg' })).toBe('image/png');
    expect(resolvePhotoContentType({ filename: 'a.mov', mime_type: null })).toBe('video/quicktime');
    expect(resolvePhotoContentType({ filename: 'a.bin', media_type: 'video' })).toBe('video/mp4');
    expect(resolvePhotoContentType({ filename: 'a', mime_type: 'image/avif' })).toBe('image/avif');
    expect(resolvePhotoContentType({ filename: 'a.constructor', mime_type: null })).toBe('image/jpeg');
  });
});

describe('serving routes use the resolver', () => {
  const routes = ['gallery.js', 'secureImages.js', 'protectedImages.js', 'adminPhotos.js'];
  it.each(routes)('%s sets no Content-Type from photo.mime_type directly', (name) => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/routes', name), 'utf8');
    expect(src).not.toMatch(/'Content-Type':\s*photo\.mime_type/);
    expect(src).not.toMatch(/set\('Content-Type',\s*photo\.mime_type\)/);
    expect(src).toMatch(/resolvePhotoContentType\(photo\)/);
  });

  it('chunked-upload init derives the MIME from the allow-listed extension', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/routes/adminPhotos.js'), 'utf8');
    expect(src).not.toMatch(/const \{ filename, fileSize, mimeType, totalChunks \} = req\.body/);
    expect(src).toMatch(/allowedMimeTypes\.includes\(mimeType\)/);
  });
});
