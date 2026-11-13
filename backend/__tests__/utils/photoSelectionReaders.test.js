/**
 * Every guest-facing photo reader decides "may this viewer see this photo"
 * through utils/photoVisibility.js (issue 2356).
 *
 * A curated selection hides the photos outside it from ordinary guests, and
 * that rule lives in applyPhotoVisibilityFilter / isPhotoHiddenFromViewer.
 * A reader that checks `visibility = 'visible'` by hand shows a guest every
 * photo of the source, so this test fails on any such check outside the
 * helper module. Admin code that filters or writes the column is listed
 * below with the reason it is not a guest reader.
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', 'src');
const HELPER = path.join('utils', 'photoVisibility.js');

// file → why its matches are not a guest reader
const ALLOWED = {
  [path.join('routes', 'adminPhotos.js')]: 'admin list filter and the admin visibility toggle',
  [path.join('routes', 'adminArchives.js')]: 'restoring an archive writes the column',
};

const HAND_WRITTEN = [
  /visibility['"`]\s*,\s*['"`]visible['"`]/,
  /visibility\s*===?\s*['"`]visible['"`]/,
  /visibility\s*==\s*null/,
  /visibility\s*:\s*['"`]visible['"`]\s*\}/,
];

function jsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : jsFiles(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });
}

describe('guest photo readers use the shared visibility rule (issue 2356)', () => {
  it('finds no hand-written visibility check outside photoVisibility.js', () => {
    const offenders = [];
    for (const file of jsFiles(SRC)) {
      const rel = path.relative(SRC, file);
      if (rel === HELPER || ALLOWED[rel]) continue;
      fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (HAND_WRITTEN.some((re) => re.test(line))) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('still recognises the shapes it forbids', () => {
    const samples = [
      'this.where(\'photos.visibility\', \'visible\').orWhereNull(\'photos.visibility\');',
      '&& (photo.visibility == null || photo.visibility === \'visible\')',
      '.where({ event_id: id, visibility: \'visible\' })',
    ];
    for (const sample of samples) expect(HAND_WRITTEN.some((re) => re.test(sample))).toBe(true);
  });
});
