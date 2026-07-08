/**
 * Photo Export Service
 * Handles exporting filtered photos in various formats
 */

const archiver = require('archiver');
const { PassThrough } = require('stream');
const { XmpGenerator } = require('./xmpGenerator');
const { db } = require('../database/db');
const path = require('path');
const fs = require('fs').promises;

class PhotoExportService {
  constructor() {
    this.xmpGenerator = new XmpGenerator();
  }

  /**
   * Get photos with full feedback data
   * @param {number} eventId - Event ID
   * @param {number[]} photoIds - Photo IDs to export (optional, exports all if not provided)
   * @returns {Promise<Object[]>} Photos with feedback
   */
  async getPhotosWithFeedback(eventId, photoIds = null) {
    let query = db('photos')
      .leftJoin('photo_categories', 'photos.category_id', 'photo_categories.id')
      .where('photos.event_id', eventId)
      .select(
        'photos.id',
        'photos.filename',
        'photos.original_filename',
        'photos.path',
        'photos.average_rating',
        'photos.feedback_count',
        'photos.like_count',
        'photos.favorite_count',
        'photos.comment_count',
        'photos.width',
        'photos.height',
        'photos.size_bytes',
        'photos.uploaded_at',
        'photo_categories.name as category_name'
      )
      .orderBy('photos.filename', 'asc');

    if (photoIds && photoIds.length > 0) {
      query = query.whereIn('photos.id', photoIds);
    }

    return await query;
  }

  /**
   * Export photos in the specified format
   * @param {number} eventId - Event ID
   * @param {number[]} photoIds - Photo IDs to export
   * @param {string} format - Export format (txt, csv, xmp, photos, json)
   * @param {Object} options - Export options
   * @returns {Promise<Object>} Export result with stream/content
   */
  async exportPhotos(eventId, photoIds, format, options = {}) {
    const photos = await this.getPhotosWithFeedback(eventId, photoIds);

    if (photos.length === 0) {
      throw new Error('No photos to export');
    }

    switch (format) {
      case 'txt':
        return this.exportAsTxt(photos, options);
      case 'csv':
        return this.exportAsCsv(photos, options);
      case 'xmp':
        return this.exportAsXmpZip(photos, options);
      case 'json':
        return this.exportAsJson(photos, eventId, options);
      default:
        throw new Error(`Unknown export format: ${format}`);
    }
  }

  /**
   * Export as plain text filename list
   *
   * include_extension defaults to true for backward compatibility with any
   * direct API consumer. The admin UI sets it to false for the Lightroom
   * search use case — the gallery JPEGs may correspond to RAW files in the
   * photographer's catalog, so the search has to match on the stem only.
   *
   * The comma separator joins without a space, the form Lightroom's filename
   * search expects (per issue #623).
   */
  exportAsTxt(photos, options = {}) {
    const {
      filename_format = 'original',
      separator = 'newline',
      include_extension = true,
    } = options;

    const filenames = photos.map(photo => {
      const name = filename_format === 'original'
        ? (photo.original_filename || photo.filename)
        : photo.filename;
      return include_extension ? name : path.parse(name).name;
    });

    let content;
    switch (separator) {
      case 'comma':
        content = filenames.join(',');
        break;
      case 'semicolon':
        content = filenames.join(';');
        break;
      default:
        content = filenames.join('\n');
    }

    return {
      type: 'text',
      content,
      filename: `photo_list_${Date.now()}.txt`,
      contentType: 'text/plain'
    };
  }

  /**
   * Export as CSV with metadata
   */
  exportAsCsv(photos, options = {}) {
    const { filename_format = 'original' } = options;

    const headers = [
      'filename',
      'original_filename',
      'rating',
      'rating_count',
      'likes',
      'favorites',
      'comments',
      'category',
      'width',
      'height',
      'size_bytes',
      'uploaded_at'
    ];

    const rows = photos.map(photo => [
      filename_format === 'original' ? (photo.original_filename || photo.filename) : photo.filename,
      photo.original_filename || '',
      photo.average_rating ? parseFloat(photo.average_rating).toFixed(2) : '0.00',
      photo.feedback_count || 0,
      photo.like_count || 0,
      photo.favorite_count || 0,
      photo.comment_count || 0,
      photo.category_name || '',
      photo.width || '',
      photo.height || '',
      photo.size_bytes || '',
      photo.uploaded_at ? new Date(photo.uploaded_at).toISOString() : ''
    ]);

    const csvContent = [
      headers.join(','),
      ...rows.map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
    ].join('\n');

    return {
      type: 'text',
      content: csvContent,
      filename: `photo_export_${Date.now()}.csv`,
      contentType: 'text/csv'
    };
  }

  /**
   * Export as XMP sidecar files in a ZIP archive
   */
  async exportAsXmpZip(photos, options = {}) {
    const { filename_format = 'original' } = options;

    const archive = archiver('zip', { zlib: { level: 9 } });
    const passthrough = new PassThrough();
    archive.pipe(passthrough);

    for (const photo of photos) {
      const baseFilename = filename_format === 'original'
        ? (photo.original_filename || photo.filename)
        : photo.filename;
      const xmpFilename = this.xmpGenerator.getXmpFilename(baseFilename);
      const xmpContent = this.xmpGenerator.generateXmp(photo, options);

      archive.append(xmpContent, { name: xmpFilename });
    }

    archive.finalize();

    return {
      type: 'stream',
      stream: passthrough,
      filename: `xmp_export_${Date.now()}.zip`,
      contentType: 'application/zip'
    };
  }

  /**
   * Export as JSON metadata
   */
  async exportAsJson(photos, eventId, options = {}) {
    // Get event info
    const event = await db('events')
      .where('id', eventId)
      .select('event_name', 'event_date', 'slug')
      .first();

    const exportData = {
      export_info: {
        event_name: event?.event_name || 'Unknown Event',
        event_date: event?.event_date,
        event_slug: event?.slug,
        exported_at: new Date().toISOString(),
        total_photos: photos.length
      },
      photos: photos.map(photo => ({
        id: photo.id,
        filename: photo.filename,
        original_filename: photo.original_filename || null,
        category: photo.category_name || null,
        rating: {
          average: photo.average_rating ? parseFloat(parseFloat(photo.average_rating).toFixed(2)) : 0,
          count: photo.feedback_count || 0
        },
        likes: photo.like_count || 0,
        favorites: photo.favorite_count || 0,
        comments: photo.comment_count || 0,
        dimensions: {
          width: photo.width || null,
          height: photo.height || null
        },
        size_bytes: photo.size_bytes || null,
        uploaded_at: photo.uploaded_at || null
      }))
    };

    return {
      type: 'text',
      content: JSON.stringify(exportData, null, 2),
      filename: `photo_metadata_${Date.now()}.json`,
      contentType: 'application/json'
    };
  }

  /**
   * Get export format display names
   */
  static getFormatOptions() {
    return [
      { value: 'txt', label: 'Filename List (TXT)', description: 'Simple text list of filenames' },
      { value: 'csv', label: 'Filename List (CSV)', description: 'Spreadsheet with metadata' },
      { value: 'xmp', label: 'XMP Sidecar Files (ZIP)', description: 'For Lightroom/Bridge/Capture One' },
      { value: 'json', label: 'Metadata (JSON)', description: 'Structured data for automation' }
    ];
  }
}

module.exports = { PhotoExportService };
