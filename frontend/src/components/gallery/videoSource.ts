/**
 * How a gallery video is played (issue 1733, adaptive streaming).
 *
 *   native  the browser plays HLS itself (Safari, iOS): the playlist goes
 *           straight into <video src>
 *   hlsjs   everywhere else with Media Source Extensions: hls.js, fetched
 *           only when such a video is opened
 *   file    no stream for this video, or nothing here can play one: the
 *           original (or its web copy), range-requested as before
 */
export type VideoSourceMode = 'native' | 'hlsjs' | 'file';

const HLS_MIME = 'application/vnd.apple.mpegurl';

export function pickVideoSource(
  hlsSrc: string | null | undefined,
  video: Pick<HTMLVideoElement, 'canPlayType'> | null = typeof document === 'undefined' ? null : document.createElement('video'),
  scope: object = typeof window === 'undefined' ? {} : window,
): VideoSourceMode {
  if (!hlsSrc) return 'file';
  if (video?.canPlayType(HLS_MIME)) return 'native';
  // ManagedMediaSource is what an iPhone offers instead of MediaSource; it
  // only matters there if native playback was not reported above.
  if ('MediaSource' in scope || 'ManagedMediaSource' in scope) return 'hlsjs';
  return 'file';
}
