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

  // In a child process: the zone of a running jest worker cannot be changed.
  // Prints the instant of the form field and of the same text read by exifr
  // from a file, as the server would have for the original.
  const instantsIn = (zone, text) => {
    const script = `
      const sharp = require('sharp');
      const exifr = require('exifr');
      const { parseClientCaptureDate } = require('./src/services/guestUploadDownscale');
      (async () => {
        const jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#888' } })
          .withExif({ IFD2: { DateTimeOriginal: ${JSON.stringify(text)} } }).jpeg().toBuffer();
        const fromFile = (await exifr.parse(jpeg, { pick: ['DateTimeOriginal'] })).DateTimeOriginal;
        const fromField = parseClientCaptureDate(${JSON.stringify(text)});
        console.log(JSON.stringify({ fromFile: fromFile.getTime(), fromField: fromField && fromField.getTime() }));
      })();`;
    const out = require('child_process').execFileSync(process.execPath, ['-e', script], {
      cwd: require('path').join(__dirname, '../..'),
      env: { ...process.env, TZ: zone },
    });
    return JSON.parse(out.toString());
  };

  test.each([
    // 02:30 does not exist in Berlin on this day; a camera elsewhere wrote it.
    ['Europe/Berlin', '2026:03:29 02:30:00'],
    // Gaza moved its clock at one minute past midnight.
    ['Asia/Gaza', '2010:03:27 01:15:45'],
    ['UTC', '2024:05:01 09:10:11'],
  ])('lands on the instant exifr reads from the file (%s, %s)', (zone, text) => {
    const { fromFile, fromField } = instantsIn(zone, text);
    expect(fromField).toBe(fromFile);
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
