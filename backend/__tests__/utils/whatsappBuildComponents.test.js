/**
 * Unit tests for the WhatsApp template-parameter selection (#647 follow-up).
 *
 * Pins:
 *  - parseTemplateParams sanitizes unknown / non-string / duplicate keys,
 *    and falls back to the default 5-slot shape on empty / malformed input.
 *  - buildComponents emits ONLY the listed slots, in the listed order, so
 *    a 2-parameter template (event_name + gallery_link) sends exactly 2
 *    positional values — the reporter's exact case from issue #647.
 *  - The legacy 5-slot default still works unchanged for installs that
 *    haven't reconfigured.
 */
const {
  buildComponents,
  parseTemplateParams,
  DEFAULT_TEMPLATE_PARAMS,
} = require('../../src/services/whatsappProcessor');

const baseData = {
  customer_name: 'Aisha',
  event_name: 'Wedding 2026',
  gallery_link: 'https://picpeak.example/wedding-2026',
  gallery_password: 'StrongPass!',
  expiry_date: '2026-12-31T00:00:00Z',
};

describe('parseTemplateParams', () => {
  test('returns the default 5-slot shape for empty / null / undefined input', () => {
    expect(parseTemplateParams('')).toEqual(DEFAULT_TEMPLATE_PARAMS);
    expect(parseTemplateParams(null)).toEqual(DEFAULT_TEMPLATE_PARAMS);
    expect(parseTemplateParams(undefined)).toEqual(DEFAULT_TEMPLATE_PARAMS);
  });

  test('returns the default shape for malformed JSON', () => {
    expect(parseTemplateParams('{not json')).toEqual(DEFAULT_TEMPLATE_PARAMS);
  });

  test('returns the default shape when JSON parses to a non-array', () => {
    expect(parseTemplateParams('"event_name"')).toEqual(DEFAULT_TEMPLATE_PARAMS);
    expect(parseTemplateParams('{"a":1}')).toEqual(DEFAULT_TEMPLATE_PARAMS);
  });

  test('preserves the reporter\'s 2-slot shape', () => {
    const out = parseTemplateParams(JSON.stringify(['event_name', 'gallery_link']));
    expect(out).toEqual(['event_name', 'gallery_link']);
  });

  test('drops unknown slot keys', () => {
    const out = parseTemplateParams(JSON.stringify([
      'event_name', 'unknown_slot', 'gallery_link', '__proto__',
    ]));
    expect(out).toEqual(['event_name', 'gallery_link']);
  });

  test('drops duplicate slot keys (first wins)', () => {
    const out = parseTemplateParams(JSON.stringify([
      'event_name', 'gallery_link', 'event_name',
    ]));
    expect(out).toEqual(['event_name', 'gallery_link']);
  });

  test('drops non-string entries', () => {
    const out = parseTemplateParams(JSON.stringify([
      'event_name', 42, null, { a: 1 }, 'gallery_link',
    ]));
    expect(out).toEqual(['event_name', 'gallery_link']);
  });

  test('falls back to default when every entry is invalid', () => {
    const out = parseTemplateParams(JSON.stringify([
      'unknown_a', 'unknown_b', null, 7,
    ]));
    expect(out).toEqual(DEFAULT_TEMPLATE_PARAMS);
  });

  test('also accepts an already-parsed array (defensive)', () => {
    const out = parseTemplateParams(['event_name', 'gallery_link']);
    expect(out).toEqual(['event_name', 'gallery_link']);
  });
});

describe('buildComponents', () => {
  test('legacy default shape emits 5 positional values, gallery_ready order', () => {
    const out = buildComponents(baseData, 'en_US');
    expect(out).toHaveLength(5);
    expect(out[0]).toBe('Aisha');
    expect(out[1]).toBe('Wedding 2026');
    expect(out[2]).toBe('https://picpeak.example/wedding-2026');
    expect(out[3]).toBe('🔒 Password: StrongPass!');
    // expiry date is locale-formatted but always non-empty for a valid date
    expect(out[4]).toMatch(/\d{2}/);
  });

  test('reporter\'s 2-slot shape — event_name + gallery_link, in that order', () => {
    const out = buildComponents(baseData, 'ar', ['event_name', 'gallery_link']);
    expect(out).toEqual(['Wedding 2026', 'https://picpeak.example/wedding-2026']);
  });

  test('reorder: gallery_link first, event_name second', () => {
    const out = buildComponents(baseData, 'en_US', ['gallery_link', 'event_name']);
    expect(out).toEqual(['https://picpeak.example/wedding-2026', 'Wedding 2026']);
  });

  test('empty slot list emits an empty components array (admin opted into nothing)', () => {
    const out = buildComponents(baseData, 'en_US', []);
    expect(out).toEqual([]);
  });

  test('password_line uses the locale-specific label when included', () => {
    const out = buildComponents(baseData, 'ar', ['password_line']);
    expect(out).toEqual(['🔒 كلمة المرور: StrongPass!']);
  });

  test('password_line is empty when no real password is set', () => {
    const out = buildComponents(
      { ...baseData, gallery_password: '' },
      'en_US',
      ['password_line'],
    );
    expect(out).toEqual(['']);
  });

  test('password_line is empty for the "No password required" sentinel', () => {
    const out = buildComponents(
      { ...baseData, gallery_password: 'No password required' },
      'en_US',
      ['password_line'],
    );
    expect(out).toEqual(['']);
  });

  test('omits expiry_date when omitted from the slot list', () => {
    const out = buildComponents(baseData, 'en_US', ['event_name']);
    expect(out).toEqual(['Wedding 2026']);
  });
});
