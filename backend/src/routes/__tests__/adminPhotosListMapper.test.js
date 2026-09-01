/**
 * `GET /api/admin/photos/:eventId/photos` hand-rolls its response object
 * field by field instead of spreading the row, so any column the admin UI
 * reads has to be listed explicitly. `visibility` (#172) was missing, which
 * meant the grid/list "Hidden" badge could never render and a photo hidden
 * from clients looked identical to a visible one (QA warning) — the same
 * class of omission that previously hid view_count / download_count.
 *
 * Source inspection rather than an HTTP round-trip: the defect is purely
 * "the key isn't in the literal", and this needs no database.
 */
const fs = require('fs');
const path = require('path');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'adminPhotos.js'), 'utf8');

// The `res.json({ photos: photos.map(photo => ({ ... })) })` literal.
const LIST_MAPPER = /photos: photos\.map\(photo => \(\{([\s\S]*?)\n {6}\}\)\)/.exec(SOURCE);

describe('admin photo list mapper', () => {
  it('has a recognisable photos.map() response literal', () => {
    expect(LIST_MAPPER).not.toBeNull();
  });

  it.each([
    'visibility',
    'view_count',
    'download_count',
  ])('exposes %s so the admin grid can render it', (field) => {
    expect(LIST_MAPPER[1]).toContain(`${field}:`);
  });

  it('normalises visibility to the two values the UI switches on', () => {
    expect(LIST_MAPPER[1]).toContain('visibility: photo.visibility === \'hidden\' ? \'hidden\' : \'visible\'');
  });
});
