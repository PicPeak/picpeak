/**
 * Tests for filenameSanitizer.
 *
 * The headline contract is the #607 fix: accented characters in event
 * names must transliterate to their ASCII base (Ägypten → Agypten) rather
 * than being dropped outright (Ägypten → gypten). This keeps the photo
 * filename consistent with the URL slug, which already does the right
 * thing via `utils/slug.js`.
 *
 * Also pins the broader header-safety contracts for buildContentDisposition
 * and the zip-entry sanitizer so a future refactor can't silently regress
 * them.
 */

const {
  sanitizeFilename,
  generatePhotoFilename,
  sanitizeForContentDisposition,
  buildContentDisposition,
  sanitizeForZipEntry,
} = require('../filenameSanitizer');

describe('sanitizeFilename — accented characters transliterate via NFD (#607)', () => {
  // Replays the broken legacy behaviour where the alphanumeric strip ran
  // BEFORE any NFD normalization, dropping the whole grapheme rather than
  // preserving the base letter. Pinned as a counter-example so a future
  // edit that removes the NFD pass fails this test set loudly.
  const legacyBroken = (s) =>
    String(s).trim()
      .replace(/\s+/g, '_')
      .replace(/[^a-zA-Z0-9_\-\.]/g, '')
      .replace(/[_\-]{2,}/g, '_')
      .replace(/^[_\-]+|[_\-]+$/g, '');

  it.each([
    ['Ägypten', 'Agypten'],
    ['Über uns', 'Uber_uns'],
    ['Niño', 'Nino'],
    ['Decoração', 'Decoracao'],
    ['Crème Brûlée', 'Creme_Brulee'],
    ['Fête de famille', 'Fete_de_famille'],
    ['Família', 'Familia'],
  ])('transliterates %j → %j (was %j before #607)', (input, expected) => {
    expect(sanitizeFilename(input)).toBe(expected);
    // Confirm the legacy pipeline would have dropped the leading character —
    // if these ever match the new output, the broken pipeline has the same
    // result and the test loses its bite (sanity guard).
    expect(legacyBroken(input)).not.toBe(expected);
  });
});

describe('sanitizeFilename — ASCII inputs unchanged', () => {
  // For pure-ASCII input the output must be byte-identical to the
  // pre-#607 pipeline, so existing photo filenames in DBs around the
  // world keep round-tripping through whatever lookups they participate
  // in.
  it.each([
    ['Wedding 2026', 'Wedding_2026'],
    ['birthday-party-42', 'birthday-party-42'],
    ['event_with_underscores', 'event_with_underscores'],
    ['CamelCase Event Name', 'CamelCase_Event_Name'],
    ['event.with.dots', 'event.with.dots'],
    ['event!@#$%^&*()chars', 'eventchars'],
  ])('preserves %j → %j', (input, expected) => {
    expect(sanitizeFilename(input)).toBe(expected);
  });
});

describe('sanitizeFilename — edge cases', () => {
  it('returns "unnamed" for falsy input', () => {
    expect(sanitizeFilename(null)).toBe('unnamed');
    expect(sanitizeFilename(undefined)).toBe('unnamed');
    expect(sanitizeFilename('')).toBe('unnamed');
  });

  it('returns "unnamed" when sanitization leaves the string empty', () => {
    expect(sanitizeFilename('婚礼')).toBe('unnamed'); // pure CJK, no NFD decomposition to ASCII
    expect(sanitizeFilename('!!!')).toBe('unnamed');
  });

  it('respects the maxLength bound', () => {
    expect(sanitizeFilename('a'.repeat(60), 10)).toBe('a'.repeat(10));
  });

  it('strips leading/trailing underscores and hyphens', () => {
    expect(sanitizeFilename('---hello---')).toBe('hello');
    expect(sanitizeFilename('___world___')).toBe('world');
  });
});

describe('generatePhotoFilename — composed name uses the NFD pipeline', () => {
  it('round-trips Ägypten + individual → Agypten_individual_0050.jpg (#607)', () => {
    expect(generatePhotoFilename('Ägypten', 'individual', 50, '.jpg'))
      .toBe('Agypten_individual_0050.jpg');
  });

  it('handles missing category by defaulting to "uncategorized"', () => {
    expect(generatePhotoFilename('Wedding', null, 1, '.jpg'))
      .toBe('Wedding_uncategorized_0001.jpg');
  });

  it('zero-pads the counter to 4 digits', () => {
    expect(generatePhotoFilename('e', 'c', 7, '.png')).toBe('e_c_0007.png');
    expect(generatePhotoFilename('e', 'c', 1234, '.png')).toBe('e_c_1234.png');
    // 5+ digit counters intentionally overflow the pad — pinned because
    // the unique index in the photos table doesn't care about pad width,
    // only string uniqueness.
    expect(generatePhotoFilename('e', 'c', 99999, '.png')).toBe('e_c_99999.png');
  });
});

describe('sanitizeForContentDisposition — header-safe ASCII fallback', () => {
  it('strips header-breaking control bytes', () => {
    expect(sanitizeForContentDisposition('hello\rworld')).toBe('helloworld');
    expect(sanitizeForContentDisposition('hello\nworld')).toBe('helloworld');
    expect(sanitizeForContentDisposition('hello\x00world')).toBe('helloworld');
  });

  it('replaces path separators and quote chars that would close the quoted-string', () => {
    expect(sanitizeForContentDisposition('a/b\\c"d')).toBe('a_b_c_d');
  });

  it('falls back to "download" on falsy input', () => {
    expect(sanitizeForContentDisposition(null)).toBe('download');
    expect(sanitizeForContentDisposition('')).toBe('download');
  });

  // The companion buildContentDisposition emits filename*=UTF-8'' alongside
  // this ASCII fallback, so unicode bytes don't reach the wire here —
  // they're carried by the RFC 5987 form on the wire instead.
  it('replaces non-ASCII bytes with _ (paired with filename*= in buildContentDisposition)', () => {
    expect(sanitizeForContentDisposition('Ägypten.jpg')).toBe('gypten.jpg');
  });
});

describe('buildContentDisposition — RFC 6266 / RFC 5987 dual form', () => {
  it('emits both filename="..." (ASCII) and filename*=UTF-8\'\'... (unicode) for accented names', () => {
    const header = buildContentDisposition('Ägypten.jpg');
    expect(header).toContain("filename=\"gypten.jpg\"");
    expect(header).toContain("filename*=UTF-8''%C3%84gypten.jpg");
    expect(header.startsWith('attachment;')).toBe(true);
  });

  it('honours the disposition argument when provided', () => {
    expect(buildContentDisposition('hello.pdf', 'inline')).toMatch(/^inline; /);
  });

  it('falls back to "download" when name is missing', () => {
    expect(buildContentDisposition('')).toContain('filename="download"');
  });
});

describe('sanitizeForZipEntry — preserves unicode, blocks path traversal', () => {
  it('preserves spaces, parentheses, and unicode (modern zip readers handle UTF-8)', () => {
    expect(sanitizeForZipEntry('Ägypten (1).jpg')).toBe('Ägypten (1).jpg');
  });

  it('normalises path separators to underscore so ../passwd becomes literal', () => {
    // The leading `../` becomes `.._` after separator-normalize. The leading
    // dots are then stripped (`^\.+/`), leaving `_etc_passwd`. The exact
    // surface form is less important than the guarantee: no `/` survives,
    // so it can never participate in a directory traversal when extracted.
    expect(sanitizeForZipEntry('../etc/passwd')).toBe('_etc_passwd');
    expect(sanitizeForZipEntry('a\\b\\c')).toBe('a_b_c');
  });

  it('strips leading dots so .. can never be an upward reference', () => {
    expect(sanitizeForZipEntry('..secret')).toBe('secret');
  });

  it('falls back to "download" on empty input', () => {
    expect(sanitizeForZipEntry('')).toBe('download');
    expect(sanitizeForZipEntry(null)).toBe('download');
  });
});
