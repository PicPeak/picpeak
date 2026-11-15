const { mergedUploadName } = require('../../src/utils/mergedUploadName');

const NAME = /^merged-[0-9a-f]{24}$/;

describe('mergedUploadName', () => {
  it('keeps a short plain extension and nothing of the client name', () => {
    const long = mergedUploadName(`${'婚'.repeat(100)}.JPG`);
    expect(long).toMatch(/^merged-[0-9a-f]{24}\.jpg$/);
    expect(Buffer.byteLength(long)).toBeLessThan(64);
    expect(mergedUploadName('clip.mp4')).toMatch(/\.mp4$/);
    expect(mergedUploadName('../../etc/passwd.heic')).toMatch(/^merged-[0-9a-f]{24}\.heic$/);
  });
  it('drops an extension that is long or not plain', () => {
    expect(mergedUploadName(`a.${'x'.repeat(40)}`)).toMatch(NAME);
    expect(mergedUploadName('a.j p')).toMatch(NAME);
    expect(mergedUploadName('noext')).toMatch(NAME);
    expect(mergedUploadName('')).toMatch(NAME);
  });
  // A thumbnail is named after the source file when no output name is given.
  it('gives every merge its own name', () => {
    expect(mergedUploadName('a.jpg')).not.toBe(mergedUploadName('a.jpg'));
  });
});
