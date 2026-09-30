import { describe, it, expect } from 'vitest';
import type { TFunction } from 'i18next';
import { formatRuntime, mediaSplitLabel, splitMediaCount } from '../mediaCounts';

describe('splitMediaCount', () => {
  it('takes the videos out of the total', () => {
    expect(splitMediaCount(143, 6)).toEqual({ photos: 137, videos: 6, hasVideos: true });
  });

  it('reads an event without videos as photos only', () => {
    expect(splitMediaCount(12, 0)).toEqual({ photos: 12, videos: 0, hasVideos: false });
    // An older backend, or a list row that predates the field.
    expect(splitMediaCount(12, undefined)).toEqual({ photos: 12, videos: 0, hasVideos: false });
  });

  it('accepts the strings Postgres hands back for aggregates', () => {
    expect(splitMediaCount('40', '40')).toEqual({ photos: 0, videos: 40, hasVideos: true });
  });

  it('never reports a negative photo count when the two numbers disagree', () => {
    // The total and the split come from two requests on the dashboard; a video
    // uploaded between them must not show "-1 photos".
    expect(splitMediaCount(3, 4)).toEqual({ photos: 0, videos: 3, hasVideos: true });
    expect(splitMediaCount(null, null)).toEqual({ photos: 0, videos: 0, hasVideos: false });
  });
});

describe('formatRuntime', () => {
  it('formats under an hour as m:ss', () => {
    expect(formatRuntime(0)).toBe('0:00');
    expect(formatRuntime(9)).toBe('0:09');
    expect(formatRuntime(754)).toBe('12:34');
  });

  it('formats from an hour up as h:mm:ss', () => {
    expect(formatRuntime(3600)).toBe('1:00:00');
    expect(formatRuntime(3723)).toBe('1:02:03');
  });

  it('treats a missing runtime as zero', () => {
    expect(formatRuntime(undefined)).toBe('0:00');
    expect(formatRuntime(null)).toBe('0:00');
  });
});

describe('mediaSplitLabel', () => {
  it('asks for both counts as plurals and joins them', () => {
    const calls: Array<[string, number]> = [];
    const t = ((key: string, _fallback: string, options: { count: number }) => {
      calls.push([key, options.count]);
      return `${options.count} ${key}`;
    }) as unknown as TFunction;

    expect(mediaSplitLabel(t, { photos: 137, videos: 6, hasVideos: true }))
      .toBe('137 events.photosCount · 6 events.videosCount');
    expect(calls).toEqual([['events.photosCount', 137], ['events.videosCount', 6]]);
  });

  it('leaves out a side that is zero', () => {
    const t = ((key: string, _fallback: string, options: { count: number }) => `${options.count} ${key}`) as unknown as TFunction;

    expect(mediaSplitLabel(t, { photos: 0, videos: 40, hasVideos: true })).toBe('40 events.videosCount');
    expect(mediaSplitLabel(t, { photos: 12, videos: 0, hasVideos: false })).toBe('12 events.photosCount');
  });
});
