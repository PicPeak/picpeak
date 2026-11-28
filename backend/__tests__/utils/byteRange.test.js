/**
 * One Range request against a file: the downloads and the website's videos
 * read it by the same rule.
 */
const { parseByteRange } = require('../../src/utils/byteRange');

describe('parseByteRange', () => {
  test.each([
    ['bytes=0-99', { start: 0, end: 99 }],
    ['bytes=500-', { start: 500, end: 999 }],
    ['bytes=900-5000', { start: 900, end: 999 }],
    // The last 100 bytes.
    ['bytes=-100', { start: 900, end: 999 }],
    ['bytes=-5000', { start: 0, end: 999 }],
  ])('%s of 1000 bytes', (header, expected) => {
    expect(parseByteRange(header, 1000)).toEqual(expected);
  });

  test.each([undefined, '', 'bytes=-', 'bytes=10-5', 'bytes=1000-', 'bytes=0-1,5-9', 'items=0-5', 'bytes=-0'])('%s cannot be served', (header) => {
    expect(parseByteRange(header, 1000)).toBeNull();
  });

  test('an empty file has no range', () => {
    expect(parseByteRange('bytes=0-', 0)).toBeNull();
  });
});
