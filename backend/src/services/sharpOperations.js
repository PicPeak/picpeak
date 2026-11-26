/* The Sharp chain operations PicPeak uses. isolatedSharp records exactly
 * these on its chain; sharpWorker (a child process) refuses any other. Kept
 * dependency-free so the worker loads nothing else with it. */
const SHARP_OPERATIONS = Object.freeze(['rotate', 'withMetadata', 'keepMetadata', 'withIccProfile', 'withExif', 'resize', 'jpeg', 'png', 'tiff', 'flatten', 'webp', 'gif', 'extract', 'composite', 'ensureAlpha', 'raw']);

module.exports = { SHARP_OPERATIONS };
