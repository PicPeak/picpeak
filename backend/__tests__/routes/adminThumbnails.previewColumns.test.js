/**
 * Source-inspection contract test for #1078.
 *
 * POST /api/admin/thumbnails/regenerate-previews hands its selected rows to
 * ensurePreviewImage, which branches on `source_origin` (and then reads
 * `external_relpath` / `filename`) to reach an external/reference photo on its
 * media mount. When the select list omitted those columns, every external row
 * looked managed, resolvePhotoStorageKey returned null, and the endpoint
 * reported success while silently generating nothing for reference galleries.
 */
const fs = require('fs');
const path = require('path');

describe('regenerate-previews selects the columns ensurePreviewImage branches on (#1078)', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'routes', 'adminThumbnails.js'),
    'utf8',
  );

  // The select feeding the regenerate-previews handler, from the route
  // declaration to the end of that statement.
  const selectStatement = (() => {
    const routeIdx = src.indexOf('/regenerate-previews');
    expect(routeIdx).toBeGreaterThan(-1);
    const selectIdx = src.indexOf('.select(', routeIdx);
    expect(selectIdx).toBeGreaterThan(-1);
    return src.slice(selectIdx, src.indexOf(';', selectIdx));
  })();

  it.each(['source_origin', 'external_relpath', 'filename'])(
    'selects %s',
    (column) => {
      expect(selectStatement).toContain(`'${column}'`);
    }
  );

  it('still selects the columns the managed path needs', () => {
    for (const column of ['id', 'event_id', 'path', 'media_type', 'mime_type', 'preview_path']) {
      expect(selectStatement).toContain(`'${column}'`);
    }
  });
});
