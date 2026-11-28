/**
 * Every guest-facing path that ships a photo's full-size bytes takes the
 * delivered row (issue 2619), so an edited photo never goes out as its
 * original. A new download path that reads the original from the row would
 * leak what an edit crops; this list makes adding one a conscious decision.
 * The routes themselves are exercised in routes/adminPhotoEditor.test.js.
 */
const fs = require('fs');
const path = require('path');

const src = (file) => fs.readFileSync(path.join(__dirname, '../../src', file), 'utf8');

describe('guest delivery paths serve the edit', () => {
  it.each([
    'routes/gallery/media.js',
    'routes/gallery/downloads.js',
    'routes/gallery/purchasedDownloads.js',
    'routes/v1/events.js',
    'services/downloadZipService.js',
    'services/downloadJobService.js',
    'services/transferService.js',
    'services/printSales/orders.js',
    'services/watermarkGeneratorService.js',
  ])('%s takes photoEdits.deliveredPhoto', (file) => {
    expect(src(file)).toMatch(/deliveredPhoto\(/);
  });

  it('the rendition code cuts from the edited source at every source it opens', () => {
    const code = src('services/imageProcessor.js');
    // One per source-open site: thumbnail, hero, thumbnail tier, preview tier, preview.
    expect(code.match(/await editedSourceKey\(photo\)/g)).toHaveLength(5);
    expect(code.match(/editedKey \|\| resolvePhotoStorageKey\(event, photo\)/g)).toHaveLength(5);
  });

  it('a download job of edited photos changes identity with every edit', () => {
    const jobs = require('../../src/services/downloadJobService');
    const key = (edits) => jobs.dedupKey(1, 'original', [1, 2], null, 'guest', false, { version: 3, edits });
    expect(key(0)).toBe(jobs.dedupKey(1, 'original', [1, 2], null, 'guest', false, { version: 3 }));
    expect(key(3)).not.toBe(key(0));
    expect(key(4)).not.toBe(key(3));
  });
});
