/**
 * An untyped media file is named by its extension (issue 2404). A dropped
 * .mov arrived without a type and was refused, while the same file picked by
 * hand carried video/quicktime and went through.
 */
const { normalizeUploadMimeType, validateFileType } = require('../../src/utils/fileSecurityUtils');

describe('normalizeUploadMimeType on untyped files', () => {
  test('names a media file by its extension when no type came with it', () => {
    expect(normalizeUploadMimeType('clip.MOV', '')).toBe('video/quicktime');
    expect(normalizeUploadMimeType('clip.mov', 'application/octet-stream')).toBe('video/quicktime');
    expect(normalizeUploadMimeType('clip.m4v', '')).toBe('video/mp4');
    expect(normalizeUploadMimeType('holiday.jpg', '')).toBe('image/jpeg');
    expect(validateFileType('clip.mov', normalizeUploadMimeType('clip.mov', ''), ['image/jpeg', 'video/quicktime'])).toBe(true);
  });

  test('the type still has to be enabled', () => {
    expect(validateFileType('clip.mov', normalizeUploadMimeType('clip.mov', ''), ['image/jpeg'])).toBe(false);
  });

  test('a named type and anything outside the media table are left alone', () => {
    expect(normalizeUploadMimeType('clip.mov', 'text/html')).toBe('text/html');
    expect(validateFileType('clip.mov', 'text/html', ['video/quicktime', 'text/html'])).toBe(false);
    expect(normalizeUploadMimeType('payload.exe', 'application/octet-stream')).toBe('application/octet-stream');
    expect(normalizeUploadMimeType(undefined, '')).toBe('');
  });
});
