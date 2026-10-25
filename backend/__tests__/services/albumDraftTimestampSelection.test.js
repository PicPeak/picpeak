const { selectTimestampPhotos, STRATEGY_VERSION } = require('../../src/services/albumDrafts/timestampSelection');

const photo = (id, time, extras = {}) => ({ id: String(id), captureTimeMs: time, ...extras });

describe('timestamp album selection (metadata only)', () => {
  test('covers the time range and returns chronological IDs', () => {
    const result = selectTimestampPhotos([photo('end', 100), photo('middle', 50), photo('start', 0), photo('early', 1)], { count: 3 });
    expect(result.photoIds).toEqual(['start', 'middle', 'end']);
    expect(result.report).toMatchObject({ strategy: STRATEGY_VERSION, selectedCount: 3, sampling: 'capture_time', fallbackReason: null });
  });

  test('always retains must-use photos and never chooses excluded photos', () => {
    const result = selectTimestampPhotos([
      photo('start', 0), photo('must', 1, { mustUse: true }), photo('other', 50),
      photo('end', 100), photo('excluded', 200, { excluded: true, mustUse: true })
    ], { count: 3 });
    expect(result.photoIds).toEqual(['start', 'must', 'end']);
    expect(result.report).toMatchObject({ eligibleCount: 4, excludedCount: 1, mustUseCount: 1 });
  });

  test('refuses to silently drop excess must-use photos', () => {
    expect(() => selectTimestampPhotos([photo('a', 0, { mustUse: true }), photo('b', 1, { mustUse: true })], { count: 1 })).toThrow(/Must-use/);
  });

  test('a single selection prefers an existing must-use choice', () => {
    expect(selectTimestampPhotos([photo('a', 0, { mustUse: true }), photo('b', 100)], { count: 1 }).photoIds).toEqual(['a']);
  });

  test('otherwise a single selection is nearest the time midpoint', () => {
    expect(selectTimestampPhotos([photo('a', 0), photo('b', 45), photo('c', 100)], { count: 1 }).photoIds).toEqual(['b']);
  });

  test('one missing eligible timestamp makes fallback explicit for the whole set', () => {
    const result = selectTimestampPhotos([photo('a', 100), photo('b', null), photo('c', 0), photo('d', 50), photo('e', 10)], { count: 3 });
    expect(result.photoIds).toEqual(['a', 'c', 'e']);
    expect(result.report).toMatchObject({ sampling: 'photo_order', fallbackReason: 'missing_capture_times', missingCaptureTimes: 1 });
  });

  test('excluded missing times do not disable capture-time sampling', () => {
    const result = selectTimestampPhotos([photo('a', 0), photo('x', null, { excluded: true }), photo('b', 100)], { count: 2 });
    expect(result.photoIds).toEqual(['a', 'b']);
    expect(result.report.sampling).toBe('capture_time');
  });

  test('identical timestamps use stable array-order fallback', () => {
    const result = selectTimestampPhotos(['e', 'd', 'c', 'b', 'a'].map(id => photo(id, 0)), { count: 3 });
    expect(result.photoIds).toEqual(['e', 'c', 'a']);
    expect(result.report.fallbackReason).toBe('identical_capture_times');
  });

  test('repeated timestamps are distributed using ordinal distance for ties', () => {
    const photos = Array.from({ length: 8 }, (_, i) => photo(`p${i}`, i < 4 ? 0 : 100));
    const result = selectTimestampPhotos(photos, { count: 4 });
    expect(result.photoIds).toEqual(['p0', 'p3', 'p5', 'p7']);
    expect(result.photoIds.filter(id => Number(id.slice(1)) < 4)).toHaveLength(2);
  });

  test('dated selection uses stable ID tie breaks independent of incoming order', () => {
    const photos = [photo('c', 10), photo('b', 0), photo('a', 0), photo('d', 20)];
    expect(selectTimestampPhotos(photos, { count: 3 })).toEqual(selectTimestampPhotos([...photos].reverse(), { count: 3 }));
  });

  test('identical duplicate IDs are collapsed without duplicate output', () => {
    const result = selectTimestampPhotos([photo('a', 0), photo('a', 0), photo('b', 100)]);
    expect(result.photoIds).toEqual(['a', 'b']);
    expect(result.report).toMatchObject({ inputCount: 3, uniqueCount: 2 });
  });

  test.each([{ captureTimeMs: 2 }, { mustUse: true }, { excluded: true }])('conflicting duplicate metadata is refused: %j', change => {
    expect(() => selectTimestampPhotos([photo('a', 0), photo('a', 0, change)])).toThrow(/conflicting/);
  });

  test('small galleries retain every eligible photo without inventing the target count', () => {
    const result = selectTimestampPhotos([photo('a', 0), photo('b', 1)]);
    expect(result.photoIds).toEqual(['a', 'b']);
    expect(result.report).toMatchObject({ requestedCount: 80, selectedCount: 2 });
  });

  test('empty and fully excluded galleries return an honest empty suggestion', () => {
    expect(selectTimestampPhotos([]).photoIds).toEqual([]);
    expect(selectTimestampPhotos([photo('a', null, { excluded: true })]).report).toMatchObject({ selectedCount: 0, eligibleCount: 0 });
  });

  test('does not mutate caller data, including frozen records', () => {
    const photos = Object.freeze([Object.freeze(photo('b', 100)), Object.freeze(photo('a', 0))]);
    expect(selectTimestampPhotos(photos).photoIds).toEqual(['a', 'b']);
    expect(photos.map(p => p.id)).toEqual(['b', 'a']);
  });

  test.each([0, 101, 2.5, NaN, '80'])('rejects an invalid target: %s', count => {
    expect(() => selectTimestampPhotos([], { count })).toThrow(/count/);
  });

  test.each([NaN, Infinity, '2026-10-25T12:00:00', new Date(), 0.5, 9e15])('requires pre-normalized valid times: %s', time => {
    expect(() => selectTimestampPhotos([photo('a', time)])).toThrow(/epoch milliseconds/);
  });

  test.each([null, {}, { id: '' }, { id: 12 }, { id: 'a', excluded: 'false' }, { id: 'a', mustUse: 1 }])('rejects malformed photo metadata: %j', input => {
    expect(() => selectTimestampPhotos([input])).toThrow(TypeError);
  });

  test('rejects a non-array input', () => {
    expect(() => selectTimestampPhotos({})).toThrow(/array/);
  });

  test('selects a reproducible default 80 from 2,000 synthetic records', () => {
    const photos = Array.from({ length: 2000 }, (_, i) => photo(`p${String(i).padStart(4, '0')}`, 1_700_000_000_000 + i * 10_000, {
      mustUse: i === 513 || i === 1447,
      excluded: i % 107 === 0 && i !== 0
    }));
    const first = selectTimestampPhotos(photos);
    expect(first).toEqual(selectTimestampPhotos(photos));
    expect(first.photoIds).toHaveLength(80);
    expect(new Set(first.photoIds).size).toBe(80);
    expect(first.photoIds).toEqual(expect.arrayContaining(['p0000', 'p0513', 'p1447', 'p1999']));
    const excluded = new Set(photos.filter(p => p.excluded).map(p => p.id));
    expect(first.photoIds.some(id => excluded.has(id))).toBe(false);
    expect(first.photoIds).toEqual([...first.photoIds].sort());
  });
});
