const fs = require('fs');
const path = require('path');

/**
 * Security contract: a capability guard only adds a refusal, so it has to sit
 * after a route's auth and access checks. In front of them an anonymous caller
 * could read the server's state from a 503. This also pins which routes are
 * guarded, so a new upload path does not quietly stay open during an outage.
 */
const ROUTES = 'src/routes';
const GUARDED = [
  ['adminPhotos.js', "router.post('/:eventId/upload'", 'requireEventOwnership'],
  ['adminPhotos.js', "router.post('/:eventId/chunked-upload/init'", 'requireEventOwnership'],
  ['publicTransferUpload.js', "router.post('/:token'", 'preUploadGuard'],
  ['adminTransfers.js', "router.post('/:id/upload-files'", "requirePermission('events.edit')"],
  ['adminTransfers.js', "router.get('/:id/download'", "requirePermission('photos.download')"],
  ['adminTransfers.js', "router.get('/:id/uploads/download'", "requirePermission('photos.download')"],
  ['adminExternalMedia.js', "router.post('/events/:id/import-external'", 'requireEventOwnership'],
  ['v1/events.js', "'/events/:id/photos',", 'requireEventOwnership'],
  ['v1/events.js', "'/events/:id/photos/download',", 'requireEventOwnership'],
];

// A resumed chunked upload must be able to finish, so these stay unguarded.
const NEVER_GUARDED = [
  ['gallery/uploads.js', "router.post('/:eventId/chunked-upload/:uploadId/chunk/:chunkIndex'"],
  ['gallery/uploads.js', "router.post('/:eventId/chunked-upload/:uploadId/complete'"],
  ['adminPhotos.js', "router.post('/:eventId/chunked-upload/:uploadId/chunk/:chunkIndex'"],
];

function declaration(file, route) {
  const source = fs.readFileSync(path.join(__dirname, '../..', ROUTES, file), 'utf8');
  const start = source.indexOf(route);
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf('async (req, res', start);
  const handle = source.indexOf('handleAsync(', start);
  return source.slice(start, Math.min(...[end, handle].filter((index) => index > -1)));
}

describe('capability guard placement', () => {
  it.each(GUARDED)('%s %s runs its guard after %s', (file, route, authCheck) => {
    const text = declaration(file, route);
    const guard = text.indexOf('requireCapability(');
    expect(guard).toBeGreaterThan(-1);
    expect(text.indexOf(authCheck)).toBeGreaterThan(-1);
    expect(text.indexOf(authCheck)).toBeLessThan(guard);
  });

  it.each([
    ['gallery/uploads.js', "router.post('/:eventId/upload'", 'guestUploadGate(req)'],
    ['gallery/uploads.js', "router.post('/:eventId/chunked-upload/init'", 'guestUploadGate(req)'],
    ['gallery/downloads.js', "router.post('/:slug/download-selected'", 'originalAssetDenial(req)'],
    ['publicTransfer.js', "router.get('/:token/download'", 'assertDownloadable(transfer)'],
  ])('%s %s refuses only after %s', (file, route, accessCheck) => {
    const source = fs.readFileSync(path.join(__dirname, '../..', ROUTES, file), 'utf8');
    const text = source.slice(source.indexOf(route));
    const check = text.indexOf('refuseCapability(req, res');
    expect(text.indexOf(accessCheck)).toBeGreaterThan(-1);
    expect(text.indexOf(accessCheck)).toBeLessThan(check);
    expect(text.slice(0, check)).not.toContain('claimDownload(');
  });

  it('decides a transfer create in its file filter, before any file is staged', () => {
    const source = fs.readFileSync(path.join(__dirname, '../..', ROUTES, 'adminTransfers.js'), 'utf8');
    const filter = source.slice(source.indexOf('fileFilter:'));
    expect(filter.indexOf('capabilityPaused(capability)')).toBeGreaterThan(-1);
    expect(filter.indexOf('capabilityPaused(capability)')).toBeLessThan(filter.indexOf('return cb(null, true)'));
    const create = source.slice(source.indexOf("router.post('/',"));
    expect(create.indexOf("requirePermission('events.edit')")).toBeLessThan(create.indexOf("{ capability: 'uploads.new' }"));
  });

  it('serves a finished archive and pauses only the on-the-fly stream', () => {
    const source = fs.readFileSync(path.join(__dirname, '../..', ROUTES, 'gallery/downloads.js'), 'utf8');
    const route = source.slice(source.indexOf("router.get('/:slug/download-all'"), source.indexOf("router.post('/:slug/download-selected'"));
    const check = route.indexOf("refuseCapability(req, res, 'downloads.archive')");
    expect(route.indexOf('verifyGalleryAccess')).toBeLessThan(check);
    expect(route.indexOf('openCachedZip')).toBeLessThan(check);
    expect(check).toBeLessThan(route.indexOf('Fallback: on-the-fly streaming'));
  });

  it.each([
    ['externalMediaWatcher.js', 'uploads.new', 'await importExternalFolder('],
    ['s3AutoImporter.js', 'uploads.new', "db('events')"],
    ['downloadZipService.js', 'downloads.archive', 'return this.generateZip(eventId);'],
  ])('%s checks %s before background work starts', (file, name, work) => {
    const source = fs.readFileSync(path.join(__dirname, '../../src/services', file), 'utf8');
    const check = source.indexOf(`evaluate('${name}').paused`);
    expect(check).toBeGreaterThan(-1);
    expect(source.indexOf(work, check)).toBeGreaterThan(check);
  });

  it.each(NEVER_GUARDED)('%s %s lets a running upload finish', (file, route) => {
    expect(declaration(file, route)).not.toContain('requireCapability(');
  });
});
