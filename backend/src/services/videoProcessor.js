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
          duration: Math.floor(metadata.format.duration || 0),
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
 * @param {string} videoPath - Local path to the source video (ffmpeg requires fs).
 * @param {string} thumbnailKey - Relative storage key for the thumbnail.
 * @returns {Promise<{success: boolean, metadata: Object, thumbnailKey: string}>}
 */
async function processUploadedVideo(videoPath, thumbnailKey, options = {}) {
  try {
    const isValid = await isValidVideo(videoPath);
    if (!isValid) {
      throw new Error('Invalid video file');
    }

    const metadata = await extractVideoMetadata(videoPath);
    await generateVideoThumbnail(videoPath, thumbnailKey, options);

    const storage = getStorage();
    const exists = await storage.exists(thumbnailKey);
    if (!exists) {
      throw new Error('Thumbnail generation failed (not in storage)');
    }

    return {
      success: true,
      metadata,
      thumbnailKey
    };
  } catch (error) {
    logger.error('Error processing video', { error: error.message, videoPath });
    throw error;
  }
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
  getThumbnailAtTime,
  isVideoMimeType
};
