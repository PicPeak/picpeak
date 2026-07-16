const path = require('path');
const { assertZipEntriesWithin } = require('../../src/utils/safePath');

describe('assertZipEntriesWithin (ZIP-slip guard, GHSA-jfhw-fj23-fx6x)', () => {
  const root = path.join('/tmp', 'picpeak-extract-root');

  it('accepts entries that stay within the extraction root', () => {
    const entries = [
      { name: 'photo.jpg' },
      { name: 'category/nested/photo.png' },
      { name: 'photos_manifest.json' },
      { name: 'subdir/' },
    ];
    expect(() => assertZipEntriesWithin(entries, root)).not.toThrow();
  });

  it('rejects a parent-traversal entry', () => {
    const entries = [{ name: '../../uploads/logos/evil.svg' }];
    expect(() => assertZipEntriesWithin(entries, root)).toThrow(/escapes the extraction directory/);
  });

  it('rejects an absolute-path entry', () => {
    const entries = [{ name: '/etc/cron.d/evil' }];
    expect(() => assertZipEntriesWithin(entries, root)).toThrow(/escapes the extraction directory/);
  });

  it('rejects when a safe entry is mixed with a traversal entry', () => {
    const entries = [{ name: 'ok.jpg' }, { name: '../escape.txt' }];
    expect(() => assertZipEntriesWithin(entries, root)).toThrow(/escapes the extraction directory/);
  });

  it('tolerates empty / nameless entries', () => {
    expect(() => assertZipEntriesWithin([{}, { name: '' }, null], root)).not.toThrow();
  });

  it('does not treat a sibling prefix directory as inside the root', () => {
    // root is .../picpeak-extract-root; ../picpeak-extract-root-evil must not pass
    const entries = [{ name: '../picpeak-extract-root-evil/x' }];
    expect(() => assertZipEntriesWithin(entries, root)).toThrow(/escapes the extraction directory/);
  });
});
