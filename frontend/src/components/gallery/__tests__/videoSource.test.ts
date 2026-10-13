/**
 * Which player a gallery video gets (issue 1733, adaptive streaming):
 * the browser's own HLS where it has one, hls.js where there is Media Source
 * Extensions, and the plain file when there is no stream or nothing to play
 * one with.
 */
import { describe, it, expect } from 'vitest';
import { pickVideoSource } from '../videoSource';

const video = (answer: string) => ({ canPlayType: () => answer as CanPlayTypeResult });
const HLS = '/api/gallery/e/hls/7/master.m3u8?v=abc';

describe('pickVideoSource', () => {
  it('plays the file when the video has no stream', () => {
    expect(pickVideoSource(null, video('maybe'), { MediaSource: class {} })).toBe('file');
    expect(pickVideoSource(undefined, video('maybe'), { MediaSource: class {} })).toBe('file');
    expect(pickVideoSource('', video('maybe'), { MediaSource: class {} })).toBe('file');
  });

  it('prefers native HLS whenever the browser reports it, MSE or not', () => {
    expect(pickVideoSource(HLS, video('maybe'), {})).toBe('native');
    expect(pickVideoSource(HLS, video('probably'), { MediaSource: class {} })).toBe('native');
  });

  it('uses hls.js where only Media Source Extensions exist', () => {
    expect(pickVideoSource(HLS, video(''), { MediaSource: class {} })).toBe('hlsjs');
    expect(pickVideoSource(HLS, video(''), { ManagedMediaSource: class {} })).toBe('hlsjs');
  });

  it('falls back to the file where neither works', () => {
    expect(pickVideoSource(HLS, video(''), {})).toBe('file');
    expect(pickVideoSource(HLS, null, {})).toBe('file');
  });
});
