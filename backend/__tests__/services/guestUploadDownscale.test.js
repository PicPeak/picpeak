const {
  GUEST_UPLOAD_MIN_EDGE, GUEST_UPLOAD_MAX_EDGE,
  isGuestUploadMaxEdge, guestUploadMaxEdgeOf, parseClientCaptureDate,
} = require('../../src/services/guestUploadDownscale');

describe('guest upload downscale setting (issue 1733)', () => {
  test('accepts whole pixel values inside the range, as number or digit string', () => {
    expect(isGuestUploadMaxEdge(GUEST_UPLOAD_MIN_EDGE)).toBe(true);
    expect(isGuestUploadMaxEdge(2048)).toBe(true);
    expect(isGuestUploadMaxEdge('2560')).toBe(true);
    expect(isGuestUploadMaxEdge(GUEST_UPLOAD_MAX_EDGE)).toBe(true);
  });

  test.each([
    GUEST_UPLOAD_MIN_EDGE - 1, GUEST_UPLOAD_MAX_EDGE + 1, 0, -2048, 2048.5, '2048.5', '2048px', '1e4', '', ' 2048',
    true, NaN, Infinity, {}, [2048],
  ])('refuses %p', (value) => {
    expect(isGuestUploadMaxEdge(value)).toBe(false);
  });

  test('the gallery payload carries the edge, or null for originals', () => {
    expect(guestUploadMaxEdgeOf({ guest_upload_max_edge: 2048 })).toBe(2048);
    // Postgres hands some integer shapes back as strings.
    expect(guestUploadMaxEdgeOf({ guest_upload_max_edge: '2048' })).toBe(2048);
    expect(guestUploadMaxEdgeOf({ guest_upload_max_edge: null })).toBeNull();
    expect(guestUploadMaxEdgeOf({ guest_upload_max_edge: 0 })).toBeNull();
    expect(guestUploadMaxEdgeOf({})).toBeNull();
    expect(guestUploadMaxEdgeOf(null)).toBeNull();
  });
});

describe('client capture date (issue 1733)', () => {
  const now = new Date(2026, 9, 12, 12, 0, 0);

  test('reads the EXIF text as server-local wall time, like exifr does', () => {
    const date = parseClientCaptureDate('2026:10:11 18:30:05', now);
    expect(date).toEqual(new Date(2026, 9, 11, 18, 30, 5));
  });

  test('keeps a wall time the server zone skips, as exifr does for the file', () => {
    const zone = process.env.TZ;
    process.env.TZ = 'Europe/Berlin';
    try {
      // 02:30 does not exist in Berlin on this day; a camera elsewhere wrote it.
      expect(parseClientCaptureDate('2026:03:29 02:30:00', now)).toEqual(new Date(2026, 2, 29, 2, 30, 0));
    } finally {
      if (zone === undefined) delete process.env.TZ; else process.env.TZ = zone;
    }
  });

  test('accepts the present moment and refuses the future', () => {
    expect(parseClientCaptureDate('2026:10:12 12:00:00', now)).toEqual(now);
    expect(parseClientCaptureDate('2026:10:12 12:00:01', now)).toBeNull();
    expect(parseClientCaptureDate('2031:01:01 00:00:00', now)).toBeNull();
  });

  test('refuses dates before 1990', () => {
    expect(parseClientCaptureDate('1989:12:31 23:59:59', now)).toBeNull();
    expect(parseClientCaptureDate('0000:00:00 00:00:00', now)).toBeNull();
  });

  test.each([
    '2026:02:30 10:00:00', // not a calendar date
    '2026:13:01 10:00:00',
    '2026:10:11 25:00:00',
    '2026:10:11 10:61:00',
    '2026-10-11T10:00:00Z', // only the EXIF shape
    '2026:10:11 10:00:00 ',
    '2026:10:11',
    '1760000000000',
    '',
    undefined,
    null,
    1760000000000,
    ['2026:10:11 10:00:00'],
    { toString: () => '2026:10:11 10:00:00' },
  ])('refuses %p', (raw) => {
    expect(parseClientCaptureDate(raw, now)).toBeNull();
  });
});
