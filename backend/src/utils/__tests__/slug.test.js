/**
 * Tests for the shared slug util extracted in #525 from the inline
 * pipelines in adminEvents.js, events.js, v1/events.js, adminArchives.js.
 *
 * Two contracts to pin:
 *   1. ASCII inputs produce byte-identical output to the previous
 *      inline pipelines, so existing event/archive slugs in the DB
 *      keep resolving via the same lookup path after the refactor.
 *   2. Accented characters (Portuguese, German, French, Spanish) are
 *      transliterated to their ASCII bases (Decoração → decoracao)
 *      instead of being dropped (Decoração → decorao) as the legacy
 *      pipelines did — same fix as #502 for category slugs.
 */

const { slugify } = require('../slug');

describe('slugify — ASCII parity with the legacy event-style pipeline', () => {
  // Replays the exact transformation used by adminEvents.js before the
  // refactor: lowercase → replace [^a-z0-9] with '-' → collapse → trim.
  const legacy = (s) =>
    String(s).toLowerCase()
      .replace(/[^a-z0-9]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');

  const samples = [
    'Wedding 2026',
    '  Hello   World  ',
    'birthday-party-42',
    'event_with_underscores',
    'CamelCase Event Name',
    '',
    'event.with.dots',
    'event!@#$%^&*()chars',
    '2026-06-12',
  ];

  it.each(samples)('matches legacy output for ASCII input: %j', (input) => {
    expect(slugify(input)).toBe(legacy(input));
  });
});

describe('slugify — accented characters (the #502 fix, now shared)', () => {
  // The legacy pipeline produced f-mlia for "Família" because the í
  // got replaced with '-' rather than being NFD-normalised to 'i'.
  // These tests pin the corrected behaviour across the locales the
  // app already ships in (de, es, fr, nl, pt, ru).
  it.each([
    ['Decoração', 'decoracao'],
    ['Família', 'familia'],
    ['Recepção', 'recepcao'],
    ['Über uns', 'uber-uns'],
    ['Niño', 'nino'],
    ['Fête de famille', 'fete-de-famille'],
    ['L\'Évènement', 'l-evenement'],
    ['Crème Brûlée', 'creme-brulee'],
  ])('transliterates %j → %j', (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });

  it('CJK and other scripts without NFD decompositions still strip cleanly', () => {
    // NFD doesn't decompose Chinese characters to ASCII, so they get
    // dropped by the [^a-z0-9]+ replace. Output is sensible if not
    // perfect — the surrounding ASCII tokens survive.
    expect(slugify('Photo 混合 Test')).toBe('photo-test');
    // Pure-CJK names collapse to empty after trim — caller's job to
    // handle (typically by appending a uniqueness suffix).
    expect(slugify('婚礼')).toBe('');
  });
});

describe('slugify — input edge cases', () => {
  it('returns empty string for null / undefined / empty', () => {
    expect(slugify(null)).toBe('');
    expect(slugify(undefined)).toBe('');
    expect(slugify('')).toBe('');
  });

  it('coerces non-string input to string before slugifying', () => {
    expect(slugify(2026)).toBe('2026');
    expect(slugify(true)).toBe('true');
  });

  it('collapses any run of non-alphanumeric chars into a single dash', () => {
    expect(slugify('a!@#$%b')).toBe('a-b');
    expect(slugify('a   b\t\nc')).toBe('a-b-c');
  });

  it('trims leading and trailing dashes', () => {
    expect(slugify('---hello---')).toBe('hello');
    expect(slugify('!!!world!!!')).toBe('world');
  });
});
