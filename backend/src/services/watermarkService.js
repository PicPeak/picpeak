const sharp = require('./isolatedSharp');
const { isResourceError } = require('./imageResourcePolicy');
const { orientedDimensions } = require('./imageProcessor');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs').promises;
const { db } = require('../database/db');
const { getStorage } = require('./storage');
const logger = require('../utils/logger');
const { sniffImageType } = require('../utils/fileSecurityUtils');
const { resolvePhotoContentType } = require('../utils/photoContentType');

// Text goes into the SVG markup: `<` or `&` in it would make the SVG invalid
// and the mark would silently not render (applyWatermark falls back to the
// unmarked original).
function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const textHash = (text) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 8);
// The gallery text a stored watermark was cut with, at the end of its key.
const textTag = (settings) => (settings?.text ? `_t${textHash(settings.text)}` : '');
const TEXT_TAG = /_t[0-9a-f]{8}$/;
// A media attempt's id, which ends an attempt's file name (watermarkKey).
const ATTEMPT_ID = /_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Bump when the tiled photo-sales pattern (salesTile) changes, so persisted
// sales previews and cached URLs are re-rendered.
const SALES_TILE_VERSION = 2;

class WatermarkService {
  constructor() {
    this.cache = new Map();
    this.cacheMaxAge = 3600000; // 1 hour in milliseconds
  }

  /**
   * Get watermark settings from database
   */
  async getWatermarkSettings() {
    try {
      const settings = await db('app_settings')
        .whereIn('setting_key', [
          'branding_watermark_enabled',
          'branding_watermark_logo_path',
          'branding_watermark_position',
          'branding_watermark_opacity',
          'branding_watermark_size',
          'branding_company_name'
        ])
        .select('setting_key', 'setting_value');

      const settingsObj = {};
      settings.forEach(setting => {
        try {
          settingsObj[setting.setting_key] = JSON.parse(setting.setting_value);
        } catch (e) {
          settingsObj[setting.setting_key] = setting.setting_value;
        }
      });

      return {
        enabled: settingsObj.branding_watermark_enabled || false,
        logoPath: settingsObj.branding_watermark_logo_path || null,
        position: settingsObj.branding_watermark_position || 'bottom-right',
        opacity: parseInt(settingsObj.branding_watermark_opacity || 50),
        size: parseInt(settingsObj.branding_watermark_size || 15),
        companyName: settingsObj.branding_company_name || 'Photo Gallery'
      };
    } catch (error) {
      logger.error('Error fetching watermark settings:', error);
      return null;
    }
  }

  /** The text a text watermark draws: the gallery's own, else the company name. */
  watermarkLabel(settings) {
    return String(settings?.text || '').trim() || String(settings?.companyName || '').trim();
  }

  /**
   * The global settings with one gallery's watermark text applied. Every
   * renderer of a gallery's photos goes through this, so the downloads, the
   * ZIPs and the gallery view draw the same text.
   */
  forEvent(settings, event) {
    if (!settings) return settings;
    const { text: _globalText, ...base } = settings;
    const text = String(event?.watermark_text || '').trim();
    return text ? { ...base, text } : base;
  }

  async getWatermarkSettingsForEvent(event) {
    return this.forEvent(await this.getWatermarkSettings(), event);
  }

  /**
   * Version of the mark for cache busting (ETags, the `wm=` URL parameter).
   * A gallery's text is part of it, so changing the text is a new URL and a
   * browser does not keep showing the old mark.
   */
  versionTag(settings) {
    // The tiled (photo sales) pattern changes the bytes on its own, so its
    // URLs and ETags must not match a single-position mark's.
    const base = `${settings.opacity}${settings.position}${settings.size}${settings.tiled ? `T${SALES_TILE_VERSION}` : ''}`;
    return settings.text ? `${base}t${textHash(settings.text)}` : base;
  }

  /**
   * Whether a stored watermark file was cut with the text these settings
   * draw. Its key carries the text (watermarkKey), so a file cut before the
   * gallery's text changed, or by a job that read the old text, is never
   * served under the new text's ETag; the photo route renders on the fly
   * and queues a fresh cut instead.
   */
  storedWatermarkCurrent(watermarkPath, settings) {
    const name = path.basename(String(watermarkPath || ''), path.extname(String(watermarkPath || '')))
      .replace(ATTEMPT_ID, '');
    const tag = textTag(settings);
    return tag ? name.endsWith(tag) : !TEXT_TAG.test(name);
  }

  /**
   * Calculate position coordinates based on position string
   */
  getPositionCoordinates(imageWidth, imageHeight, watermarkWidth, watermarkHeight, position) {
    const padding = 20;
    let left, top;

    switch (position) {
    case 'top-left':
      left = padding;
      top = padding;
      break;
    case 'top-right':
      left = imageWidth - watermarkWidth - padding;
      top = padding;
      break;
    case 'bottom-left':
      left = padding;
      top = imageHeight - watermarkHeight - padding;
      break;
    case 'bottom-right':
      left = imageWidth - watermarkWidth - padding;
      top = imageHeight - watermarkHeight - padding;
      break;
    case 'center':
      left = Math.floor((imageWidth - watermarkWidth) / 2);
      top = Math.floor((imageHeight - watermarkHeight) / 2);
      break;
    default:
      // Default to bottom-right
      left = imageWidth - watermarkWidth - padding;
      top = imageHeight - watermarkHeight - padding;
    }

    return { left: Math.max(0, left), top: Math.max(0, top) };
  }

  /**
   * Photo sales: the repeating tile of the tiled mark. A third of the image
   * wide, so a 1920px preview carries about nine marks rather than a wall of
   * text: the text runs diagonally in white with a dark outline (legible on
   * light and dark photos, no box behind it); a logo sits centred with
   * transparent space around it. Never larger than the image (sharp refuses
   * a tile that is).
   */
  async salesTile(metadata, label, logoBuffer, logoMetadata, settings) {
    const width = Math.max(48, Math.min(metadata.width, Math.round(metadata.width / 3)));
    const height = Math.max(32, Math.min(metadata.height, Math.round(width * 0.62)));
    const transparent = { r: 0, g: 0, b: 0, alpha: 0 };
    if (logoBuffer && logoMetadata) {
      const fit = await sharp(logoBuffer)
        .resize(Math.max(1, Math.floor(width * 0.6)), Math.max(1, Math.floor(height * 0.6)), { fit: 'inside' })
        .toBuffer({ resolveWithObject: true });
      const left = Math.floor((width - fit.info.width) / 2);
      const top = Math.floor((height - fit.info.height) / 2);
      return sharp(fit.data)
        .extend({ top, left, bottom: height - fit.info.height - top, right: width - fit.info.width - left, background: transparent })
        .png()
        .toBuffer();
    }
    const text = String(label || '');
    const fontSize = Math.max(10, Math.min(Math.floor(width / 9), Math.floor((width * 1.1) / Math.max(1, text.length * 0.6))));
    const opacity = Math.min(1, Math.max(0.15, Number(settings.opacity || 40) / 100));
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
      <text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle"
        transform="rotate(-24 ${width / 2} ${height / 2})"
        font-family="Arial, Helvetica, sans-serif" font-weight="600" font-size="${fontSize}"
        fill="#ffffff" fill-opacity="${opacity}"
        stroke="#000000" stroke-opacity="${(opacity * 0.45).toFixed(2)}" stroke-width="${Math.max(1, fontSize / 18).toFixed(1)}"
        paint-order="stroke">${escapeXml(text)}</text>
    </svg>`;
    return Buffer.from(svg);
  }

  /**
   * Apply watermark to an image
   */
  /**
   * `imagePath` may be a path OR an in-memory Buffer (#858). Buffers let the
   * download paths resize first and watermark second without a second tmp
   * file — which matters because the mark is sized relative to the input's
   * own width, so it has to be applied at the OUTPUT size to come out right.
   */
  async applyWatermark(imagePath, settings, { keepMetadata = false, failClosed = false } = {}) {
    const isBuffer = Buffer.isBuffer(imagePath);
    try {
      if (!settings || !settings.enabled) {
        // Return original image if watermarking is disabled
        return isBuffer ? imagePath : await fs.readFile(imagePath);
      }

      // Check cache first. Buffer inputs are already-resized intermediates:
      // they have no stable key (hashing megabytes per photo would cost more
      // than the watermark) and no reuse across requests, so skip the cache.
      // keepMetadata is part of the key: the gallery-view rendition and the
      // download of the same photo must never serve each other's bytes.
      // So is the file's version (size and modification time, statted here):
      // a file on a reference share is edited in place under the same path,
      // and every process must stop serving the old picture as soon as it
      // reads the new one, not only the one whose import pass noticed.
      let cacheKey = null;
      if (!isBuffer) {
        const st = await fs.stat(imagePath).catch(() => null);
        if (st) cacheKey = `${imagePath}_${st.size}:${st.mtimeMs}_${JSON.stringify(settings)}_${keepMetadata ? 'meta' : 'stripped'}`;
      }
      if (cacheKey) {
        const cached = this.cache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < this.cacheMaxAge) {
          return cached.buffer;
        }
      }

      // Load the main image.
      //
      // .rotate() for the same reason as the other generators (#1185): sharp
      // decodes the pixels as stored, so an orientation-tagged photo would be
      // composited and re-encoded sideways — and gallery.js serves
      // watermark_path ahead of the original, so this is exactly what a guest
      // sees.
      const image = sharp(imagePath).rotate();

      // Deliberately NOT `await image.metadata()`: .rotate() does not change
      // what metadata() reports — a 400x200 source tagged orientation 6 still
      // reads 400x200 there, even though the pipeline now emits 200x400. Every
      // use below is positioning (watermark scale, font size, composite
      // extent), so it has to be the DISPLAYED size or the mark lands against
      // the wrong axis.
      const rawMetadata = await sharp(imagePath).metadata();
      const oriented = orientedDimensions(rawMetadata);
      const metadata = { ...rawMetadata, width: oriented.width, height: oriented.height };

      let watermarkBuffer;
      let watermarkMetadata;

      // Try to use logo watermark first
      if (settings.logoPath) {
        try {
          const watermarkImage = sharp(settings.logoPath);
          watermarkMetadata = await watermarkImage.metadata();
          
          // Calculate watermark size based on percentage of main image
          const scaleFactor = settings.size / 100;
          const targetWidth = Math.floor(metadata.width * scaleFactor);
          const targetHeight = Math.floor(watermarkMetadata.height * (targetWidth / watermarkMetadata.width));

          // Resize watermark and apply opacity
          watermarkBuffer = await watermarkImage
            .resize(targetWidth, targetHeight, { fit: 'inside' })
            .composite([{
              input: Buffer.from([255, 255, 255, Math.floor(255 * (settings.opacity / 100))]),
              raw: {
                width: 1,
                height: 1,
                channels: 4
              },
              tile: true,
              blend: 'dest-in'
            }])
            .toBuffer();

          watermarkMetadata = { width: targetWidth, height: targetHeight };
        } catch (error) {
          logger.error('Error processing watermark logo:', error);
          if (isResourceError(error)) throw error;
          watermarkBuffer = null;
        }
      }

      // The gallery's own text (settings.text, see forEvent) wins over the
      // global company name.
      const label = this.watermarkLabel(settings);

      // Nothing to draw (no usable logo, no text) is not a failed
      // watermark: fail-closed callers must not turn it into an error.
      if (!watermarkBuffer && !label) {
        return isBuffer ? imagePath : await fs.readFile(imagePath);
      }

      // If no logo or logo failed, create text watermark
      if (!watermarkBuffer) {
        const padding = 10;
        // Estimated from the characters drawn, not from the escaped markup.
        const textWidth = (size) => label.length * size * 0.6 + padding * 2;
        // The mark has to fit inside the image or sharp refuses the
        // composite: a long name on a 300px thumbnail is wider than the
        // thumbnail at the 16px floor. Shrink the font to fit, down to 8px.
        let fontSize = Math.max(16, Math.floor(metadata.width * 0.03));
        if (textWidth(fontSize) > metadata.width) {
          fontSize = Math.max(8, Math.floor((metadata.width - padding * 2) / (label.length * 0.6)));
        }
        const svgWidth = Math.ceil(textWidth(fontSize));
        const svgHeight = fontSize + padding * 2;
        // Still too large at the floor: render the whole mark smaller, through
        // the viewBox, so it stays legible in proportion and never overflows.
        const scale = Math.min(1, metadata.width / svgWidth, metadata.height / svgHeight);
        const markWidth = Math.max(1, Math.floor(svgWidth * scale));
        const markHeight = Math.max(1, Math.floor(svgHeight * scale));

        // Create SVG text watermark
        const svg = `
          <svg width="${markWidth}" height="${markHeight}" viewBox="0 0 ${svgWidth} ${svgHeight}">
            <rect x="0" y="0" width="100%" height="100%" fill="black" opacity="0.5" rx="5"/>
            <text x="${padding}" y="${fontSize + padding/2}" 
              font-family="Arial, sans-serif" 
              font-size="${fontSize}" 
              fill="white" 
              opacity="${settings.opacity / 100}">
              ${escapeXml(label)}
            </text>
          </svg>
        `;
        
        watermarkBuffer = Buffer.from(svg);
        watermarkMetadata = { width: markWidth, height: markHeight };
      }

      // Calculate position
      const position = this.getPositionCoordinates(
        metadata.width,
        metadata.height,
        watermarkMetadata.width,
        watermarkMetadata.height,
        settings.position
      );

      // Apply watermark with high quality output to preserve original image quality.
      //
      // Floored: getPositionCoordinates derives from the SVG's estimated text
      // extent, which is fractional, and sharp rejects a non-integer offset
      // outright — applyWatermark then catches its own error and silently
      // returns the unwatermarked original. Whether it lands on a whole pixel
      // was previously luck; nothing guaranteed it.
      let watermarkedImage;
      // Photo sales: tiled mode repeats the mark across the
      // whole image (strong protection for paid photos before checkout).
      // Without the option the single-position composite below is used, so
      // non-priced galleries render byte-identically to upstream PicPeak.
      if (settings.tiled) {
        watermarkedImage = image.composite([{
          input: await this.salesTile(metadata, label, settings.logoPath ? watermarkBuffer : null, watermarkMetadata, settings),
          tile: true,
        }]);
      } else {
        watermarkedImage = image.composite([{
          input: watermarkBuffer,
          top: Math.max(0, Math.floor(position.top)),
          left: Math.max(0, Math.floor(position.left))
        }]);
      }

      // A DOWNLOAD keeps the photo's EXIF, XMP and IPTC (issue 1649) — same
      // reasoning as resizeToBox: the credit travels with the file the guest
      // takes away. Only downloadRendition asks for it. Every other caller
      // makes the gallery-VIEW rendition (gallery/media.js, the persisted
      // watermark_path), which stays stripped like every other rendition:
      // a viewer who cannot download must not read the GPS tag either.
      // rotate() above has already corrected the pixels, and keepMetadata()
      // resets the Orientation tag to 1 to match.
      if (keepMetadata) watermarkedImage = watermarkedImage.keepMetadata();

      // Preserve original format with high quality settings
      const format = metadata.format || 'jpeg';
      let watermarkedBuffer;

      if (format === 'png') {
        watermarkedBuffer = await watermarkedImage.png({ quality: 100, compressionLevel: 6 }).toBuffer();
      } else if (format === 'webp') {
        watermarkedBuffer = await watermarkedImage.webp({ quality: 95, lossless: false }).toBuffer();
      } else {
        // Default to JPEG with maximum quality (100) to prevent recompression
        watermarkedBuffer = await watermarkedImage.jpeg({ quality: 100, mozjpeg: true }).toBuffer();
      }

      // Cache the result (path inputs only — see cacheKey above)
      if (cacheKey) {
        this.cache.set(cacheKey, {
          buffer: watermarkedBuffer,
          timestamp: Date.now()
        });

        // Clean old cache entries
        this.cleanCache();
      }

      return watermarkedBuffer;
    } catch (error) {
      logger.error('Error applying watermark:', error);
      if (failClosed || isResourceError(error)) throw error;
      // Return the un-watermarked input on error. Buffer inputs are already
      // in memory — readFile() would treat the Buffer as a path and throw,
      // turning a cosmetic watermark failure into a failed download.
      return isBuffer ? imagePath : await fs.readFile(imagePath);
    }
  }

  /**
   * Clean old cache entries
   */
  cleanCache() {
    const now = Date.now();
    for (const [key, value] of this.cache.entries()) {
      if (now - value.timestamp > this.cacheMaxAge) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Forget every cached result made from one source file, for a file whose
   * bytes changed under the same path (a reference photo edited in place).
   */
  forgetSource(imagePath) {
    const prefix = `${imagePath}_`;
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) this.cache.delete(key);
    }
  }

  /**
   * Clear entire cache
   */
  clearCache() {
    this.cache.clear();
  }

  /**
   * Get the file extension from a filename
   */
  getFileExtension(filename) {
    const ext = path.extname(filename).toLowerCase();
    // Map common extensions
    if (ext === '.jpeg') return '.jpg';
    return ext || '.jpg';
  }

  /**
   * Storage key of a photo's watermark. Named after the file it is cut from
   * as well as the photo id: a replacement keeps the id, and a job still
   * cutting the old file must not overwrite the new file's watermark. An
   * external file edited in place keeps its name, so its version (size and
   * mtime, see imageProcessor's sourceVersion) is part of the name too, and
   * so is the gallery's watermark text (see storedWatermarkCurrent). The
   * attempt id stays last: mediaAttemptService recognises an attempt's file
   * by it ending the name.
   */
  watermarkKey(photo, attempt = null, settings = null) {
    const version = require('./imageProcessor').sourceVersion(photo);
    const source = crypto.createHash('sha256')
      .update(String(photo.filename || '') + (version ? `\0${version}` : '')).digest('hex').slice(0, 12);
    return `watermarks/${photo.id}_watermarked_${source}${textTag(settings)}${attempt ? `_${attempt.id}` : ''}${this.getFileExtension(photo.filename || '')}`;
  }

  /**
   * Generate watermarked version of a photo and persist it through the
   * storage backend. The source must be a local filesystem path because
   * sharp doesn't take streams; callers in S3 mode should materialize a
   * tmp local copy via imageProcessor.withLocalCopy first.
   *
   * @param {Object} photo - Photo object with id, filename, and path info
   * @param {string} originalPath - Local path to the original image file
   * @param {Object} settings - Watermark settings (optional, will fetch if not provided)
   * @returns {Object} { success, watermarkPath, error }
   */
  async generateAndSaveWatermark(photo, originalPath, settings = null) {
    let uploaded = null;
    try {
      if (!settings) {
        settings = await this.getWatermarkSettings();
      }

      if (!settings || !settings.enabled) {
        return { success: false, watermarkPath: null, error: 'Watermarking is disabled' };
      }

      try {
        await fs.access(originalPath);
      } catch {
        return { success: false, watermarkPath: null, error: 'Original file not found' };
      }

      const watermarkedBuffer = await this.applyWatermark(originalPath, settings);

      const attempt = require('./mediaAttemptContext').current();
      const relativePath = this.watermarkKey(photo, attempt, settings);

      await attempt?.assertCurrent();
      await getStorage().put(relativePath, watermarkedBuffer, {
        // Usually the JPEG applyWatermark re-encoded, but it hands back the
        // original when it has nothing to draw or fails to render: the bytes
        // decide, and bytes it never writes are the original's (issue 2178).
        contentType: sniffImageType(watermarkedBuffer) || resolvePhotoContentType(photo),
      });
      uploaded = relativePath;
      await attempt?.assertCurrent();

      return {
        success: true,
        watermarkPath: relativePath,
        error: null
      };
    } catch (error) {
      // Refused after the upload (the attempt lost its claim): nothing will
      // record the file, and its name is this attempt's alone.
      if (uploaded) await getStorage().delete(uploaded).catch(() => {});
      logger.error(`Error generating watermark for photo ${photo.id}:`, error);
      return {
        success: false,
        watermarkPath: null,
        error: error.message
      };
    }
  }

  /**
   * Delete a pre-generated watermark file from the storage backend.
   * @param {string} watermarkPath - Relative storage key (e.g. "watermarks/123_watermarked.jpg")
   * @returns {boolean} - True if a delete was attempted (no-op if missing)
   */
  async deleteWatermarkFile(watermarkPath) {
    if (!watermarkPath) return false;

    try {
      await getStorage().delete(watermarkPath);
      return true;
    } catch (error) {
      logger.error('Error deleting watermark file:', error);
      return false;
    }
  }

  /**
   * Create a hash of current watermark settings for change detection
   * @returns {string} - Hash string of settings
   */
  async getSettingsHash() {
    const settings = await this.getWatermarkSettings();
    if (!settings) return '';

    const hashData = `${settings.enabled}-${settings.logoPath || ''}-${settings.position}-${settings.opacity}-${settings.size}`;
    // Simple hash for change detection (not cryptographic)
    let hash = 0;
    for (let i = 0; i < hashData.length; i++) {
      const char = hashData.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return hash.toString(16);
  }
}

module.exports = new WatermarkService();
