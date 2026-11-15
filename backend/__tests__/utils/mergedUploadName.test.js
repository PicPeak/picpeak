const { mergedUploadName } = require('../../src/utils/mergedUploadName');

describe('mergedUploadName', () => {
  it('keeps a short plain extension and nothing of the client name', () => {
    expect(mergedUploadName(`${'婚'.repeat(100)}.JPG`)).toBe('merged.jpg');
    expect(mergedUploadName('clip.mp4')).toBe('merged.mp4');
    expect(mergedUploadName('../../etc/passwd.heic')).toBe('merged.heic');
  });
  it('drops an extension that is long or not plain', () => {
    expect(mergedUploadName(`a.${'x'.repeat(40)}`)).toBe('merged');
    expect(mergedUploadName('a.j p')).toBe('merged');
    expect(mergedUploadName('noext')).toBe('merged');
    expect(mergedUploadName('')).toBe('merged');
  });
});
