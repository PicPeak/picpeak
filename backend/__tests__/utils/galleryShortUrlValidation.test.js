/**
 * Pure-function tests for the slug validator in galleryShortUrlService.
 * The validator is the security boundary for the `/s/<slug>` public
 * route — bad shapes leak into a UNIQUE column that's used in URLs
 * without further escaping, so the rules need to be tight.
 */

// Provide a minimal db stub so requiring the service doesn't crash —
// the validator path doesn't touch the DB.
jest.mock('../../src/database/db', () => ({ db: jest.fn() }));
jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../../src/utils/appSettings', () => ({
  getAppSetting: jest.fn().mockResolvedValue(false),
}));

const {
  validateSlug,
  _RESERVED_SLUGS,
} = require('../../src/services/galleryShortUrlService');

describe('validateSlug', () => {
  describe('accepts', () => {
    test.each([
      'sofia-graduation',
      'sofia',
      'a',                   // single char (alphanumeric)
      '1',                   // single digit
      'abc123',
      '123-abc',
      'sofia-2026-06-05',
      'sofia-2026',
      'a-b-c-d',
      'wedding-2026',
      'xK7p2'.toLowerCase(), // lowercase 5-char
      'a'.repeat(64),        // exactly at the limit
    ])('%j', (slug) => {
      expect(validateSlug(slug)).toBeNull();
    });
  });

  describe('rejects', () => {
    test.each([
      ['', 'cannot be empty'],
      ['   ', 'cannot be empty'],          // trimmed → empty
      ['-sofia', 'lowercase letters'],     // leading hyphen
      ['sofia-', 'lowercase letters'],     // trailing hyphen
      ['Sofia', 'lowercase letters'],      // uppercase
      ['sofia_graduation', 'lowercase letters'],  // underscore
      ['sofia.graduation', 'lowercase letters'],  // dot
      ['sofia graduation', 'lowercase letters'],  // space
      ['sofia/graduation', 'lowercase letters'],  // slash (path traversal vector)
      ['sofia%20graduation', 'lowercase letters'],
      ['a'.repeat(65), 'at most 64'],      // one over limit
    ])('%j → %s', (slug, expectedReason) => {
      const result = validateSlug(slug);
      expect(result).not.toBeNull();
      expect(result.toLowerCase()).toContain(expectedReason);
    });

    test('null', () => {
      expect(validateSlug(null)).toContain('must be a string');
    });

    test('undefined', () => {
      expect(validateSlug(undefined)).toContain('must be a string');
    });

    test('number', () => {
      expect(validateSlug(42)).toContain('must be a string');
    });

    test('object', () => {
      expect(validateSlug({})).toContain('must be a string');
    });
  });

  describe('reserved slugs', () => {
    test.each([
      'admin',
      'api',
      'auth',
      'gallery',
      'og',
      'health',
      's',           // can't shadow the shortener itself
      'login',
      'favicon.ico', // even with the dot — covered by SLUG_REGEX fail too
    ])('reserves %j', (slug) => {
      expect(_RESERVED_SLUGS.has(slug)).toBe(true);
    });

    test('"admin" → rejected with "reserved" reason', () => {
      // validateSlug short-circuits at the regex for slugs containing
      // dots (favicon.ico fails the regex first). Test a clean
      // alphanumeric reserved word.
      const result = validateSlug('admin');
      expect(result).toBe('short_slug is reserved');
    });
  });

  describe('path-traversal + URL-injection vectors are rejected at the regex', () => {
    test.each([
      '../etc/passwd',
      'foo/../bar',
      'foo?query=1',
      'foo#fragment',
      'foo&bar',
      'foo bar',
      'foo<script>',
      'foo>',
      'foo"',
      'foo\'',
      'foo;rm -rf',
    ])('%j', (slug) => {
      expect(validateSlug(slug)).not.toBeNull();
    });
  });
});
