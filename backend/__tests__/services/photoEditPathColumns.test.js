/**
 * Every column of migration 380 that names an edit file (issue 2619) is
 * collected when a photo's edit files are deleted, and read by the gallery
 * delete's projection before the rows go: a path left out survives as an
 * unreferenced file in storage.
 */
const fs = require('fs');
const path = require('path');

const migration = fs.readFileSync(path.join(__dirname, '../../migrations/core/380_photo_editor.js'), 'utf8');
const pathColumns = [...new Set([...migration.matchAll(/'(edit_[a-z_]*path)'/g)].map((m) => m[1]))];

describe('edit file columns', () => {
  it('the migration has some (the list below is not empty by accident)', () => {
    expect(pathColumns).toEqual(expect.arrayContaining(['edit_render_path', 'edit_applied_render_path']));
  });

  it.each(pathColumns)('%s is collected by editCacheKeys', (column) => {
    const { editCacheKeys } = require('../../src/services/photoEdits');
    const key = 'edits/edit_p7_r2_s0123456789_abcdef012345.jpg';
    const row = { id: 7, filename: 'a.jpg', edit_params: null, edit_rev: 0, edit_applied_rev: 0, [column]: key };
    expect(editCacheKeys(row)).toContain(key);
  });

  it.each(pathColumns)('%s is read by the gallery delete before the rows go', (column) => {
    const helpers = fs.readFileSync(path.join(__dirname, '../../src/routes/adminEvents/helpers.js'), 'utf8');
    const photoEdits = require('../../src/services/photoEdits');
    const projected = helpers.includes(`'${column}'`) || (helpers.includes('EDIT_FILE_COLUMNS') && photoEdits.EDIT_FILE_COLUMNS.includes(column));
    expect(projected).toBe(true);
  });
});
