const { vatMinorFor } = require('../../src/utils/vatAmount');
const { isUnitedKingdom } = require('../../src/utils/postalAddress');

describe('vatMinorFor', () => {
  it('rounds to the nearest cent by default', () => {
    expect(vatMinorFor(1234, 20)).toBe(247); // 246.8
    expect(vatMinorFor(1232, 20)).toBe(246); // 246.4
    expect(vatMinorFor(10000, 8.1)).toBe(810);
  });

  it('rounds down to the whole penny for a UK business (Notice 700 s.17.5)', () => {
    expect(vatMinorFor(1234, 20, { roundDown: true })).toBe(246); // 246.8
    expect(vatMinorFor(4999, 20, { roundDown: true })).toBe(999); // 999.8
    expect(vatMinorFor(1232, 20, { roundDown: true })).toBe(246);
  });

  it('keeps an exact whole penny', () => {
    expect(vatMinorFor(1000, 20, { roundDown: true })).toBe(200);
    expect(vatMinorFor(2000, 8.1, { roundDown: true })).toBe(162);
    expect(vatMinorFor(2850, 20, { roundDown: true })).toBe(570);
  });

  it('rounds a credit towards zero', () => {
    expect(vatMinorFor(-1234, 20, { roundDown: true })).toBe(-246);
  });

  it('treats a missing net or rate as zero', () => {
    expect(vatMinorFor(null, 20)).toBe(0);
    expect(vatMinorFor(1000, undefined, { roundDown: true })).toBe(0);
  });
});

describe('isUnitedKingdom', () => {
  it('matches GB and UK in any case', () => {
    expect(isUnitedKingdom('GB')).toBe(true);
    expect(isUnitedKingdom(' gb ')).toBe(true);
    expect(isUnitedKingdom('UK')).toBe(true);
    expect(isUnitedKingdom('US')).toBe(false);
    expect(isUnitedKingdom(null)).toBe(false);
  });
});
