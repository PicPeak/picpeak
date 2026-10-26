/**
 * The displayed size and the capture date of a video, read from ffprobe
 * (issue 2263).
 */

const { displayDimensions, videoCaptureDate } = require('../../src/utils/videoProbe');

describe('displayDimensions', () => {
  const coded = { width: 1920, height: 1080 };

  it.each([
    ['side data -90 (iPhone portrait)', { side_data_list: [{ side_data_type: 'Display Matrix', rotation: -90 }] }, 1080, 1920],
    ['side data 90', { side_data_list: [{ side_data_type: 'Display Matrix', rotation: 90 }] }, 1080, 1920],
    ['side data 270', { side_data_list: [{ rotation: 270 }] }, 1080, 1920],
    ['side data 180', { side_data_list: [{ rotation: 180 }] }, 1920, 1080],
    ['the older rotate tag', { tags: { rotate: '90' } }, 1080, 1920],
    ['a 180 rotate tag', { tags: { rotate: '180' } }, 1920, 1080],
    ['no rotation', {}, 1920, 1080],
    ['side data without a rotation entry', { side_data_list: [{ side_data_type: 'Ambient viewing' }] }, 1920, 1080],
  ])('%s', (_label, extra, width, height) => {
    expect(displayDimensions({ ...coded, ...extra })).toEqual({ width, height });
  });

  it('prefers the side data over the tag', () => {
    expect(displayDimensions({ ...coded, side_data_list: [{ rotation: 0 }], tags: { rotate: '90' } }))
      .toEqual({ width: 1920, height: 1080 });
  });

  it('answers null without a video stream', () => {
    expect(displayDimensions(undefined)).toEqual({ width: null, height: null });
  });
});

describe('videoCaptureDate', () => {
  const probe = (formatTags, streamTags) => ({
    format: { tags: formatTags },
    streams: [{ codec_type: 'audio', tags: { creation_time: '2001-01-01T00:00:00Z' } }, { codec_type: 'video', tags: streamTags }],
  });

  it('reads the container creation_time', () => {
    expect(videoCaptureDate(probe({ creation_time: '2025-06-15T12:30:00.000000Z' }))?.toISOString())
      .toBe('2025-06-15T12:30:00.000Z');
  });

  it('prefers Apple\'s creationdate, with its offset', () => {
    expect(videoCaptureDate(probe({
      'com.apple.quicktime.creationdate': '2025-06-15T14:30:00+0200',
      creation_time: '2025-07-01T09:00:00.000000Z',
    }))?.toISOString()).toBe('2025-06-15T12:30:00.000Z');
  });

  it('falls back to the video stream, not the audio one', () => {
    expect(videoCaptureDate(probe({}, { creation_time: '2024-03-02T08:00:00.000000Z' }))?.toISOString())
      .toBe('2024-03-02T08:00:00.000Z');
  });

  it.each([
    ['the 1970 epoch', '1970-01-01T00:00:00.000000Z'],
    ['the QuickTime epoch', '1904-01-01T00:00:00.000000Z'],
    ['zeros', '0000-00-00T00:00:00.000000Z'],
    ['garbage', 'not a date'],
    ['the future', '2999-01-01T00:00:00.000000Z'],
  ])('ignores %s and reads the next candidate', (_label, value) => {
    expect(videoCaptureDate(probe({ creation_time: value }))).toBeNull();
    expect(videoCaptureDate(probe({ creation_time: value }, { creation_time: '2024-03-02T08:00:00Z' }))?.toISOString())
      .toBe('2024-03-02T08:00:00.000Z');
  });

  it('answers null when there are no tags', () => {
    expect(videoCaptureDate({ format: {}, streams: [] })).toBeNull();
    expect(videoCaptureDate(undefined)).toBeNull();
  });
});
