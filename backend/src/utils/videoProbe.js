/**
 * Readings of an ffprobe result (`-show_format -show_streams`) shared by the
 * upload pipeline (videoProcessor) and the HLS ladder (videoHlsService).
 */

/**
 * The size a viewer sees. A phone records portrait as landscape pixels plus a
 * rotation (display matrix side data, or the older `rotate` tag), and every
 * player and ffmpeg itself apply it, so a ±90° turn swaps the coded width and
 * height (issue 2263).
 */
function displayDimensions(videoStream) {
  const rotation = Number(videoStream?.side_data_list?.find(item => item.rotation !== undefined)?.rotation
    ?? videoStream?.tags?.rotate ?? 0);
  const turned = Math.abs(rotation) % 180 === 90;
  return {
    width: (turned ? videoStream?.height : videoStream?.width) || null,
    height: (turned ? videoStream?.width : videoStream?.height) || null,
  };
}

// The range extractCaptureDate accepts for a photo. Cameras without a clock
// write 1970 or the QuickTime epoch (1904), and "0000-00-00" does not parse.
const MIN_CAPTURE_DATE = Date.parse('1990-01-01T00:00:00Z');

/**
 * When the clip was recorded, or null. Apple's creationdate carries the
 * recording's own offset and survives an export that rewrites creation_time,
 * so it is read first; then the container's creation_time, then the video
 * stream's.
 */
function videoCaptureDate(metadata) {
  const formatTags = metadata?.format?.tags || {};
  const videoStream = (metadata?.streams || []).find(s => s.codec_type === 'video');
  const candidates = [
    formatTags['com.apple.quicktime.creationdate'],
    formatTags.creation_time,
    videoStream?.tags?.creation_time,
  ];
  for (const value of candidates) {
    if (typeof value !== 'string' || !value.trim()) continue;
    const time = Date.parse(value.trim());
    if (Number.isFinite(time) && time > MIN_CAPTURE_DATE && time <= Date.now()) return new Date(time);
  }
  return null;
}

module.exports = { displayDimensions, videoCaptureDate };
