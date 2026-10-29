'use strict';
const { ValidationError } = require('../../utils/errors');
const { jpegDensity } = require('./jpegDensity');
const { pngDensity } = require('./pngDensity');
const colours = require('./colourProfiles');
const fail = message => { throw new ValidationError(message); };
/** Only implemented encodings reach the renderer. No file paths or supplier presets. */
function output(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Choose supported RGB output requirements');
  const colour = colours.profile(input.colourSpace);
  const allowed = { jpeg: ['quality', 'chromaSubsampling'], png: ['compressionLevel'], tiff: ['compression'] };
  if (!Object.hasOwn(allowed, input.format) ||
      Object.keys(input).some(k => !['format', 'colourSpace', 'profileSha256', ...allowed[input.format]].includes(k)))
    fail('Choose supported JPEG, PNG or TIFF output requirements');
  if (input.profileSha256 !== undefined && input.profileSha256 !== colour.sha256) fail('Output ICC profile identity changed');
  const result = { format: input.format, colourSpace: input.colourSpace, ...(colour.sha256 ? { profileSha256: colour.sha256 } : {}) };
  if (input.format === 'jpeg') {
    const quality = input.quality === undefined ? 95 : input.quality,
      chromaSubsampling = input.chromaSubsampling === undefined ? '4:4:4' : input.chromaSubsampling;
    if (!Number.isSafeInteger(quality) || quality < 1 || quality > 100 || !['4:4:4', '4:2:0'].includes(chromaSubsampling))
      fail('Choose JPEG quality from 1 to 100 and supported chroma sampling');
    Object.assign(result, { quality, chromaSubsampling });
  } else if (input.format === 'png') {
    const compressionLevel = input.compressionLevel === undefined ? 6 : input.compressionLevel;
    if (!Number.isSafeInteger(compressionLevel) || compressionLevel < 0 || compressionLevel > 9)
      fail('Choose PNG compression from 0 to 9');
    result.compressionLevel = compressionLevel;
  } else {
    const compression = input.compression === undefined ? 'lzw' : input.compression;
    if (!['lzw', 'deflate', 'none'].includes(compression)) fail('Choose supported TIFF compression');
    result.compression = compression;
  }
  return result;
}
async function encode(raster, requirements, dpi) {
  const spec = output(requirements);
  raster = raster.withIccProfile(colours.verifiedProfile(spec.colourSpace).icc, { attach: true });
  if (spec.format === 'jpeg') return { extension: 'jpg', bytes: jpegDensity(await raster
    .jpeg({ quality: spec.quality, chromaSubsampling: spec.chromaSubsampling }).toBuffer(), dpi) };
  if (spec.format === 'png') return { extension: 'png', bytes: pngDensity(await raster
    .png({ compressionLevel: spec.compressionLevel }).toBuffer(), dpi) };
  return { extension: 'tif', bytes: await raster.tiff({ compression: spec.compression,
    xres: dpi / 25.4, yres: dpi / 25.4, resolutionUnit: 'inch' }).toBuffer() };
}
module.exports = { output, encode };
