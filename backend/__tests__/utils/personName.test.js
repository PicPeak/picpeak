const { sanitizeName } = require('../../src/utils/personName');

describe('sanitizeName — one Unicode form per name', () => {
  it('stores a decomposed name the same as the precomposed one', () => {
    const composed = 'J\u00F6rg M\u00FCller';
    const decomposed = 'Jo\u0308rg Mu\u0308ller';
    expect(sanitizeName(decomposed)).toBe(composed);
    expect(sanitizeName(composed)).toBe(composed);
  });

  it('normalises after removing invisible characters that split a letter from its mark', () => {
    expect(sanitizeName('e\u200B\u0301')).toBe('\u00E9');
    expect(sanitizeName('J\u202Eo\u0308rg')).toBe('J\u00F6rg');
  });

  it('counts the length limit on the normalised name', () => {
    // 100 decomposed "é" are 200 code points; normalised they are 100.
    const name = 'e\u0301'.repeat(100);
    expect(sanitizeName(name)).toBe('\u00E9'.repeat(100));
  });
});
