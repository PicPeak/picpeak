const sharp = require('sharp');
const path = require('path');
const fs = require('fs').promises;
const { db } = require('../database/db');
const { getStorage } = require('./storage');
const logger = require('../utils/logger');

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
   * Apply watermark to an image
   */
  async applyWatermark(imagePath, settings) {
    try {
      if (!settings || !settings.enabled) {
        // Return original image if watermarking is disabled
        return await fs.readFile(imagePath);
      }

      // Check cache first
      const cacheKey = `${imagePath}_${JSON.stringify(settings)}`;
      const cached = this.cache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < this.cacheMaxAge) {
        return cached.buffer;
      }

      // Load the main image
      const image = sharp(imagePath);
      const metadata = await image.metadata();

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
          watermarkBuffer = null;
        }
      }

      // If no logo or logo failed, create text watermark
      if (!watermarkBuffer) {
        const fontSize = Math.max(16, Math.floor(metadata.width * 0.03));
        const padding = 10;
        
        // Create SVG text watermark
        const svg = `
          <svg width="${settings.companyName.length * fontSize * 0.6 + padding * 2}" height="${fontSize + padding * 2}">
            <rect x="0" y="0" width="100%" height="100%" fill="black" opacity="0.5" rx="5"/>
            <text x="${padding}" y="${fontSize + padding/2}" 
              font-family="Arial, sans-serif" 
              font-size="${fontSize}" 
              fill="white" 
              opacity="${settings.opacity / 100}">
              ${settings.companyName}
            </text>
          </svg>
        `;
        
        watermarkBuffer = Buffer.from(svg);
        watermarkMetadata = {
          width: settings.companyName.length * fontSize * 0.6 + padding * 2,
          height: fontSize + padding * 2
        };
      }

      // Calculate position
      const position = this.getPositionCoordinates(
        metadata.width,
        metadata.height,
        watermarkMetadata.width,
        watermarkMetadata.height,
        settings.position
      );

      // Apply watermark with high quality output to preserve original image quality
      let watermarkedImage = image.composite([{
        input: watermarkBuffer,
        top: position.top,
        left: position.left
      }]);

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

      // Cache the result
      this.cache.set(cacheKey, {
        buffer: watermarkedBuffer,
        timestamp: Date.now()
      });

      // Clean old cache entries
      this.cleanCache();

      return watermarkedBuffer;
    } catch (error) {
      logger.error('Error applying watermark:', error);
      // Return original image on error
      return await fs.readFile(imagePath);
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

      const ext = this.getFileExtension(photo.filename);
      const outputFilename = `${photo.id}_watermarked${ext}`;
      const relativePath = `watermarks/${outputFilename}`;

      await getStorage().put(relativePath, watermarkedBuffer, {
        contentType: ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg',
      });

      return {
        success: true,
        watermarkPath: relativePath,
        error: null
      };
    } catch (error) {
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