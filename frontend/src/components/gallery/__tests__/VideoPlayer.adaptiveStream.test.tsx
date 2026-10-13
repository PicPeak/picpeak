/**
 * The player's source for a video with an adaptive stream (issue 1733):
 * native HLS goes into <video src>, hls.js is loaded only for a video that
 * has a stream, and a stream that fails hands over to the file.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, waitFor, act } from '@testing-library/react';

const hlsInstances: Array<{
  config: { enableWorker?: boolean };
  loadSource: ReturnType<typeof vi.fn>;
  attachMedia: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  handlers: Record<string, (event: string, data: { fatal: boolean }) => void>;
}> = [];
const hlsLoaded = vi.fn();

vi.mock('hls.js', () => {
  hlsLoaded();
  class FakeHls {
    static isSupported = () => true;
    static Events = { ERROR: 'hlsError' };
    config: { enableWorker?: boolean };
    handlers: Record<string, (event: string, data: { fatal: boolean }) => void> = {};
    loadSource = vi.fn();
    attachMedia = vi.fn();
    destroy = vi.fn();
    constructor(config: { enableWorker?: boolean }) {
      this.config = config;
      hlsInstances.push(this);
    }
    on(event: string, handler: (event: string, data: { fatal: boolean }) => void) {
      this.handlers[event] = handler;
    }
  }
  return { default: FakeHls };
});

import { VideoPlayer } from '../VideoPlayer';

const FILE = '/api/gallery/e/photo/7';
const STREAM = '/api/gallery/e/hls/7/master.m3u8?v=abc';

function browser({ nativeHls, mse }: { nativeHls: boolean; mse: boolean }) {
  vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue(nativeHls ? 'maybe' : '');
  if (mse) vi.stubGlobal('MediaSource', class {});
  else {
    vi.stubGlobal('MediaSource', undefined);
    delete (window as unknown as Record<string, unknown>).MediaSource;
  }
}

describe('VideoPlayer with an adaptive stream', () => {
  beforeEach(() => {
    hlsInstances.length = 0;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('plays the file, and loads no hls.js, when the video has no stream', async () => {
    browser({ nativeHls: false, mse: true });
    hlsLoaded.mockClear();
    const { container } = render(<VideoPlayer src={FILE} />);
    expect(container.querySelector('video')).toHaveAttribute('src', FILE);
    await act(async () => { await Promise.resolve(); });
    expect(hlsLoaded).not.toHaveBeenCalled();
    expect(hlsInstances).toHaveLength(0);
  });

  it('hands the playlist to the browser where HLS is native', () => {
    browser({ nativeHls: true, mse: true });
    const { container } = render(<VideoPlayer src={FILE} hlsSrc={STREAM} />);
    expect(container.querySelector('video')).toHaveAttribute('src', STREAM);
    expect(hlsInstances).toHaveLength(0);
  });

  it('falls back to the file when native playback of the stream errors', () => {
    browser({ nativeHls: true, mse: false });
    const { container } = render(<VideoPlayer src={FILE} hlsSrc={STREAM} />);
    const video = container.querySelector('video')!;
    fireEvent.error(video);
    expect(video).toHaveAttribute('src', FILE);
    // Not an error the guest has to read: the file is still to come.
    expect(container.textContent).not.toMatch(/could not be loaded/i);
  });

  it('attaches hls.js, without a worker, where only MSE exists', async () => {
    browser({ nativeHls: false, mse: true });
    const { container } = render(<VideoPlayer src={FILE} hlsSrc={STREAM} />);
    const video = container.querySelector('video')!;
    expect(video).not.toHaveAttribute('src');
    await waitFor(() => expect(hlsInstances).toHaveLength(1));
    expect(hlsInstances[0].config.enableWorker).toBe(false);
    expect(hlsInstances[0].loadSource).toHaveBeenCalledWith(STREAM);
    expect(hlsInstances[0].attachMedia).toHaveBeenCalledWith(video);
  });

  it('drops a stream that fails fatally and plays the file', async () => {
    browser({ nativeHls: false, mse: true });
    const { container } = render(<VideoPlayer src={FILE} hlsSrc={STREAM} />);
    await waitFor(() => expect(hlsInstances).toHaveLength(1));
    act(() => hlsInstances[0].handlers.hlsError('hlsError', { fatal: false }));
    expect(container.querySelector('video')).not.toHaveAttribute('src');
    act(() => hlsInstances[0].handlers.hlsError('hlsError', { fatal: true }));
    expect(container.querySelector('video')).toHaveAttribute('src', FILE);
    expect(hlsInstances[0].destroy).toHaveBeenCalled();
  });

  it('picks the file up where the failed stream had got to', async () => {
    browser({ nativeHls: false, mse: true });
    const { container } = render(<VideoPlayer src={FILE} hlsSrc={STREAM} />);
    const video = container.querySelector('video')!;
    Object.defineProperty(video, 'currentTime', { value: 0, writable: true });
    await waitFor(() => expect(hlsInstances).toHaveLength(1));
    video.currentTime = 95;
    act(() => hlsInstances[0].handlers.hlsError('hlsError', { fatal: true }));
    expect(video).toHaveAttribute('src', FILE);
    // A new source starts at 0:00; the position comes back with its metadata.
    video.currentTime = 0;
    fireEvent.loadedMetadata(video);
    expect(video.currentTime).toBe(95);
    // Once only: a later reload of the same file is not sent back there.
    video.currentTime = 0;
    fireEvent.loadedMetadata(video);
    expect(video.currentTime).toBe(0);
  });

  it('keeps the source a video was opened with when the photo list is refreshed', () => {
    // A download-limited gallery names the stream only once the video has
    // its slot: the list refetch behind the first play must not swap the
    // source under the viewer and send them back to 0:00.
    browser({ nativeHls: true, mse: true });
    const { container, rerender } = render(<VideoPlayer src={FILE} hlsSrc={null} />);
    const video = container.querySelector('video')!;
    expect(video).toHaveAttribute('src', FILE);
    rerender(<VideoPlayer src={FILE} hlsSrc={STREAM} />);
    expect(video).toHaveAttribute('src', FILE);
    // A stream rebuilt meanwhile (a new `v`) is not swapped in either.
    const other = '/api/gallery/e/photo/8';
    rerender(<VideoPlayer src={other} hlsSrc={STREAM} />);
    expect(video).toHaveAttribute('src', STREAM);
    rerender(<VideoPlayer src={other} hlsSrc={`${STREAM}2`} />);
    expect(video).toHaveAttribute('src', STREAM);
  });

  it('plays the file where the browser can do neither', () => {
    browser({ nativeHls: false, mse: false });
    const { container } = render(<VideoPlayer src={FILE} hlsSrc={STREAM} />);
    expect(container.querySelector('video')).toHaveAttribute('src', FILE);
    expect(hlsInstances).toHaveLength(0);
  });
});
