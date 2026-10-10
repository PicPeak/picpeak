const { normalizeStatusColors, STATUS_KEYS } = require('../statusColors');

describe('normalizeStatusColors', () => {
  it('keeps the five known keys with a #rrggbb value, lower-cased', () => {
    expect(normalizeStatusColors({ success: '#16A34A', storno: ' #9333ea ' }))
      .toEqual({ success: '#16a34a', storno: '#9333ea' });
    expect(STATUS_KEYS).toEqual(['success', 'warning', 'danger', 'info', 'storno']);
  });

  it('drops unknown keys and anything that is not a 6-digit hex colour', () => {
    expect(normalizeStatusColors({
      danger: 'red',
      info: '#fff',
      warning: 'url(javascript:alert(1))',
      success: '#16a34a; background:red',
      primary: '#000000',
    })).toEqual({});
  });

  it('returns an empty object for missing or malformed input', () => {
    for (const value of [undefined, null, '', 'x', 42, ['#000000']]) {
      expect(normalizeStatusColors(value)).toEqual({});
    }
  });
});
