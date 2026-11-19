/**
 * Event codes (issue 2495): generation, input normalisation, validation and
 * display form. The database side is covered in routes/eventAccessCode.test.js.
 */
jest.mock('../../src/database/db', () => ({ db: jest.fn() }));

const {
  ALPHABET, generateAccessCode, normalizeAccessCode, isValidAccessCode, formatAccessCode,
} = require('../../src/services/eventAccessCode');

describe('event code helpers', () => {
  it('uses an alphabet without look-alikes', () => {
    for (const ch of '01OIL') expect(ALPHABET).not.toContain(ch);
    expect(ALPHABET).toHaveLength(31);
  });

  it('generates 6 characters from the alphabet', () => {
    for (let i = 0; i < 200; i += 1) {
      const code = generateAccessCode();
      expect(code).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/);
      expect(isValidAccessCode(code)).toBe(true);
    }
  });

  it('normalises case, dashes and spaces', () => {
    expect(normalizeAccessCode('k7m-4qx')).toBe('K7M4QX');
    expect(normalizeAccessCode(' K7M 4QX ')).toBe('K7M4QX');
    expect(normalizeAccessCode('k7m--4 qx')).toBe('K7M4QX');
    expect(normalizeAccessCode(undefined)).toBe('');
    expect(normalizeAccessCode(123)).toBe('');
  });

  it('accepts 6 to 12 characters of the alphabet only', () => {
    expect(isValidAccessCode('ABCDEF')).toBe(true);
    expect(isValidAccessCode('ABCDE')).toBe(false);
    expect(isValidAccessCode('ABCD')).toBe(false);
    expect(isValidAccessCode('MUEPPER2525')).toBe(true);
    expect(isValidAccessCode('ABC')).toBe(false);
    expect(isValidAccessCode('ABCDEFGHJKMNP')).toBe(false);
    for (const bad of ['K7M0QX', 'K7MOQX', 'K7M1QX', 'K7MIQX', 'K7MLQX', 'k7m4qx', 'K7M-4QX', 'K7M%QX', '']) {
      expect(isValidAccessCode(bad)).toBe(false);
    }
    expect(isValidAccessCode(null)).toBe(false);
  });

  it('groups a 6-character code for display and leaves other lengths alone', () => {
    expect(formatAccessCode('K7M4QX')).toBe('K7M-4QX');
    expect(formatAccessCode('MUEPPER24')).toBe('MUEPPER24');
    expect(formatAccessCode(null)).toBeNull();
  });
});
