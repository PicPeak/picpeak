/**
 * Website builder (issue 2618): the cache of rendered pages. A miss is
 * cached too (a crawler walking random addresses costs one lookup each),
 * and a value computed before a publish cleared the cache is not stored.
 */
describe('page cache', () => {
  const { cacheGeneration, getCached, setCached, clearWebsiteCache } = require('../cache');
  test('keeps a miss apart from no entry', () => {
    clearWebsiteCache();
    expect(getCached('page:nope')).toBeUndefined();
    setCached('page:nope', null, cacheGeneration());
    expect(getCached('page:nope')).toBeNull();
    clearWebsiteCache();
    expect(getCached('page:nope')).toBeUndefined();
  });

  test('a value from before a clear is not stored', () => {
    const startedAt = cacheGeneration();
    clearWebsiteCache();
    setCached('page:old', { status: 200 }, startedAt);
    expect(getCached('page:old')).toBeUndefined();
  });
});
