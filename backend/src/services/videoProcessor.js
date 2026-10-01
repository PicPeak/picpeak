const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const os = require('os');
const crypto = require('crypto');
const logger = require('../utils/logger');
const { getStorage } = require('./storage');

// Use system ffmpeg/ffprobe (apk-installed in the Docker image, brew/apt on
// dev hosts). The npm `@ffmpeg-installer/ffmpeg` binary is glibc-built and
// (a) doesn't run reliably on Alpine and (b) only ships ffmpeg, not ffprobe
// — but `ffmpeg.ffprobe()` below needs both. Letting fluent-ffmpeg fall
// back to PATH lookup picks up the apk-installed binaries inside the
// container and the developer's locally-installed ones outside it.

/**
 * Extract video metadata using FFmpeg
 * @param {string} videoPath - Path to the video file
 * @returns {Promise<Object>} - Video metadata
 */
async function extractVideoMetadata(videoPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoPath, (err, metadata) => {
      if (err) {
        logger.error('Error extracting video metadata', { error: err.message, videoPath });
        return reject(err);
      }

      try {
        const videoStream = metadata.streams.find(s => s.codec_type === 'video');
        const audioStream = metadata.streams.find(s => s.codec_type === 'audio');

        const result = {
          // null (not 0) when ffprobe genuinely has no duration — a real
          // 0-second clip and "unknown" must stay distinguishable, since
          // downstream code treats `duration != null` as "trust this value".
          duration: metadata.format.duration != null ? Math.floor(metadata.format.duration) : null,
          width: videoStream?.width || null,
          height: videoStream?.height || null,
          videoCodec: videoStream?.codec_name || null,
          audioCodec: audioStream?.codec_name || null,
          size: metadata.format.size || 0,
          bitrate: metadata.format.bit_rate || null,
          format: metadata.format.format_name || null
        };

        resolve(result);
      } catch (parseErr) {
        logger.error('Error parsing video metadata', { error: parseErr.message });
        reject(parseErr);
      }
    });
  });
}

/**
 * Generate a video thumbnail and persist it via the storage backend.
 *
 * @param {string} videoPath - Local path to the video file (ffmpeg needs a real fs path).
 * @param {string} thumbnailKey - Relative storage key the thumbnail will be saved under
 *                                (e.g. "thumbnails/thumb_video.jpg").
 * @param {Object} options
 * @returns {Promise<string>} The thumbnail's relative storage key.
 */
async function generateVideoThumbnail(videoPath, thumbnailKey, options = {}) {
  const {
    timeOffset = '00:00:01',
    size = '300x300'
  } = options;

  const storage = getStorage();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'picpeak-vidthumb-'));
  const tmpFilename = `${crypto.randomBytes(4).toString('hex')}_${path.basename(thumbnailKey)}`;
  const tmpPath = path.join(tmpDir, tmpFilename);

  try {
    await new Promise((resolve, reject) => {
      ffmpeg(videoPath)
        .screenshots({
          timestamps: [timeOffset],
          filename: tmpFilename,
          folder: tmpDir,
          size: size
        })
        .on('end', () => resolve())
        .on('error', (err) => reject(err));
    });

    if (!fsSync.existsSync(tmpPath)) {
      throw new Error('ffmpeg did not produce a thumbnail file');
    }

    await storage.putFromFile(thumbnailKey, tmpPath, { contentType: 'image/jpeg' });
    logger.info('Video thumbnail generated', { videoPath, thumbnailKey });
    return thumbnailKey;
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Validate that a file is a valid video
 * @param {string} videoPath - Path to the video file
 * @returns {Promise<boolean>} - True if valid video
 */
async function isValidVideo(videoPath) {
  try {
    const metadata = await extractVideoMetadata(videoPath);
    return metadata.duration > 0 && metadata.width > 0 && metadata.height > 0;
  } catch (error) {
    logger.error('Video validation failed', { error: error.message, videoPath });
    return false;
  }
}

/**
 * Get video duration in seconds
 * @param {string} videoPath - Path to the video file
 * @returns {Promise<number>} - Duration in seconds
 */
async function getVideoDuration(videoPath) {
  try {
    const metadata = await extractVideoMetadata(videoPath);
    return metadata.duration;
  } catch (error) {
    logger.error('Error getting video duration', { error: error.message });
    return 0;
  }
}

/**
 * Process an uploaded video: extract metadata and produce a thumbnail through
 * the storage backend.
 *
 * Metadata extraction and thumbnail generation are independent, best-effort
 * steps — mirroring how the image pipeline treats thumbnail/dimension/EXIF
 * failures (log a warning, keep the upload). This used to gate everything
 * behind isValidVideo(), which rejects the whole video if ffprobe can't read
 * even one of duration/width/height — common on some iPhone/Lightroom-
 * exported MP4s (#1370). Callers (photoProcessor.js's processPhoto and
 * processUploadedPhotos) already catch that throw and fall back to a static
 * placeholder thumbnail plus a metadata-only retry (codex review of #845),
 * but that fallback never got a REAL thumbnail even when
 * generateVideoThumbnail() would have succeeded on its own — thumbnailing
 * doesn't need valid duration/width/height, it just seeks and grabs a frame.
 * Trying both steps independently means a real thumbnail (and whatever
 * metadata ffprobe *can* read) survives far more often. metadata is still
 * allowed to come back null (ffprobe failed) — a video with no thumbnail
 * would fall back to rendering the raw video as an <img> in the gallery
 * grid (`photo.thumbnail_url || photo.url`), so this only resolves when a
 * real thumbnail or the SVG placeholder produced *something*; if both fail
 * (storage backend down, disk full — not a quirk of one file) it throws
 * instead, so the caller surfaces a retryable failure rather than silently
 * completing with nothing to show.
 *
 * @param {string} videoPath - Local path to the source video (ffmpeg requires fs).
 * @param {string} thumbnailKey - Relative storage key for the thumbnail.
 * @returns {Promise<{success: boolean, metadata: Object|null, thumbnailKey: string}>}
 */
async function processUploadedVideo(videoPath, thumbnailKey, options = {}) {
  let metadata = null;
  try {
    metadata = await extractVideoMetadata(videoPath);
  } catch (error) {
    logger.error('Video metadata extraction failed — continuing without duration/codec/dimensions', {
      error: error.message,
      videoPath
    });
  }

  let generatedThumbnailKey = null;
  // Why the poster frame is missing, kept for the row: a video that completed
  // with the placeholder used to be indistinguishable from one with a real
  // poster frame, so the admin saw a grey tile and nothing to act on
  // (issue 1430, item 6).
  let thumbnailError = null;
  try {
    await generateVideoThumbnail(videoPath, thumbnailKey, options);
    const storage = getStorage();
    if (await storage.exists(thumbnailKey)) {
      generatedThumbnailKey = thumbnailKey;
    } else {
      thumbnailError = 'ffmpeg produced no poster frame';
    }
  } catch (error) {
    thumbnailError = error.message;
    logger.error('Video thumbnail generation failed — continuing without a thumbnail', {
      error: error.message,
      videoPath
    });
  }

  // Never return "success" with no thumbnail at all: the gallery grid
  // (GridGalleryLayout/JustifiedGalleryLayout) falls back to
  // `photo.thumbnail_url || photo.url` when there's no thumbnail, which
  // makes AuthenticatedImage download the full ORIGINAL VIDEO and try to
  // render it as an <img> — a broken tile and a multi-GB fetch just from
  // opening the gallery (codex review, #1371/#1372). Fall back to the same
  // ffmpeg-free SVG placeholder the callers already generate for a total
  // processing failure, so a bare thumbnail-generation failure degrades to
  // that placeholder too, not to "no thumbnail". thumbnailKey is always
  // `thumbnails/thumb_<name>.jpg` (see callers) — strip the prefix back to
  // a filename so generateVideoPlaceholder recomputes this exact same key.
  // Tracked as a flag, not by comparing keys: the placeholder lands under the
  // very same key as a real frame would (that is the point of the filename
  // derivation below), so the key alone cannot tell the two apart.
  let usedPlaceholder = false;
  if (!generatedThumbnailKey) {
    try {
      const {
        generateVideoPlaceholder,
        DEFAULT_THUMBNAIL_WIDTH,
        DEFAULT_THUMBNAIL_HEIGHT
      } = require('./imageProcessor');
      const placeholderFilename = path.basename(thumbnailKey).replace(/^thumb_/, '');
      // Explicit width/height make generateVideoPlaceholder skip its
      // configured-thumbnail-size DB lookup (see its own comment) — this
      // call can run from inside processUploadedPhotos' open per-file
      // SQLite transaction, where that lookup would otherwise deadlock.
      const placeholderKey = await generateVideoPlaceholder(placeholderFilename, {
        width: DEFAULT_THUMBNAIL_WIDTH,
        height: DEFAULT_THUMBNAIL_HEIGHT
      });
      if (placeholderKey) {
        generatedThumbnailKey = placeholderKey;
        usedPlaceholder = true;
      }
    } catch (error) {
      logger.error('Video placeholder generation also failed', { error: error.message, videoPath });
    }
  }

  // A real thumbnail AND the ffmpeg-free SVG placeholder both failing points
  // at something systemic (storage backend down, disk full) rather than a
  // quirk of this one file — that's worth surfacing as a retryable failure
  // rather than silently completing with no thumbnail at all, which would
  // make the gallery fall back to rendering the raw video as an <img>
  // (codex review, #1371/#1372). Metadata (if any was extracted) is lost
  // here, same trade-off the callers' own pre-existing total-failure
  // handling already makes.
  if (!generatedThumbnailKey) {
    throw new Error('Unable to generate any thumbnail (real or placeholder) for this video');
  }

  return {
    success: true,
    metadata,
    thumbnailKey: generatedThumbnailKey,
    // True when thumbnailKey holds the SVG placeholder, not a frame of the video.
    placeholder: usedPlaceholder,
    thumbnailError: usedPlaceholder ? thumbnailError : null
  };
}

/**
 * The processing_error text for a video that completed with the placeholder
 * tile. One place, so the upload worker, the synchronous upload path and the
 * external import write the same note and the admin grid can show it.
 */
function posterFrameError(reason) {
  // ffmpeg's message runs to several lines and names the file's path on
  // disk; the first line without the path says what the admin can act on.
  const detail = reason
    ? String(reason).split('\n')[0].replace(/\/[^\s'"]+/g, '…').trim().slice(0, 200)
    : '';
  return detail ? `No poster frame: ${detail}` : 'No poster frame: ffmpeg could not read the video';
}

/**
 * Get video thumbnail at specific time
 * @param {string} videoPath - Path to video file
 * @param {string} outputPath - Output path for thumbnail
 * @param {number} timeInSeconds - Time in seconds to capture thumbnail
 * @returns {Promise<string>} - Path to thumbnail
 */
async function getThumbnailAtTime(videoPath, outputPath, timeInSeconds = 1) {
  const hours = Math.floor(timeInSeconds / 3600);
  const minutes = Math.floor((timeInSeconds % 3600) / 60);
  const seconds = Math.floor(timeInSeconds % 60);
  const timeOffset = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;

  return generateVideoThumbnail(videoPath, outputPath, { timeOffset });
}

/**
 * Check if file is a video based on MIME type
 * @param {string} mimeType - MIME type of the file
 * @returns {boolean} - True if video MIME type
 */
function isVideoMimeType(mimeType) {
  return mimeType && mimeType.startsWith('video/');
}

module.exports = {
  extractVideoMetadata,
  generateVideoThumbnail,
  isValidVideo,
  getVideoDuration,
  processUploadedVideo,
  posterFrameError,
  getThumbnailAtTime,
  isVideoMimeType
};
