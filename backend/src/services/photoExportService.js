/**
 * Photo Export Service
 * Handles exporting filtered photos in various formats
 */

const archiver = require('archiver');
const { PassThrough } = require('stream');
const { XmpGenerator } = require('./xmpGenerator');
const { dominantColorLabel } = require('../constants/colorLabels');
const photoAdminMarksService = require('./photoAdminMarksService');
const feedbackService = require('./feedbackService');
const { neutralizeSpreadsheetFormula } = require('../utils/spreadsheetSafe');
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
  async getPhotosWithFeedback(eventId, photoIds = null, adminId = null) {
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
        'photos.color_label_count',
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

    const photos = await query;

    // Colour labels (#1044). One grouped query for the whole export, then
    // each row carries both the per-colour tallies and the single colour the
    // XMP sidecar should claim.
    const colorCounts = await feedbackService.getEventColorLabelCounts(
      eventId,
      photos.map(p => p.id),
    );
    for (const photo of photos) {
      photo.color_labels = colorCounts[photo.id] || {};
      photo.dominant_color_label = dominantColorLabel(photo.color_labels);
    }

    // The exporting photographer's own marks (#1044 follow-up), so a triage
    // pass can leave the app as XMP the same way a client selection can.
    if (adminId) {
      const marks = await photoAdminMarksService.getEventMarks(
        eventId, adminId, photos.map(p => p.id),
      );
      for (const photo of photos) {
        photo.my_rating = marks[photo.id]?.rating ?? null;
        photo.my_color_label = marks[photo.id]?.color_label ?? null;
      }
    }

    return photos;
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
    // admin_id is set by the route from the session, never taken from the
    // request body — it decides whose marks the export carries.
    const photos = await this.getPhotosWithFeedback(eventId, photoIds, options.admin_id || null);

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
      'color_label',
      'my_rating',
      'my_color_label',
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
      photo.dominant_color_label || '',
      photo.my_rating ?? '',
      photo.my_color_label || '',
      photo.category_name || '',
      photo.width || '',
      photo.height || '',
      photo.size_bytes || '',
      photo.uploaded_at ? new Date(photo.uploaded_at).toISOString() : ''
    ]);

    const csvContent = [
      headers.join(','),
      // Formula-neutralize each cell before quoting — filenames/categories
      // are user-controlled, and quoting alone doesn't stop `=cmd()`
      // execution (GHSA-5364).
      ...rows.map(row => row.map(cell => `"${neutralizeSpreadsheetFormula(cell).replace(/"/g, '""')}"`).join(','))
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
    const { filename_format = 'original', mark_source = 'client' } = options;

    // Whose verdict the sidecar carries (#1044 follow-up). Default 'client'
    // keeps existing exports identical; 'mine' writes the photographer's own
    // triage instead, which is the point of being able to mark at all.
    const project = (photo) => (mark_source !== 'mine' ? photo : {
      ...photo,
      average_rating: photo.my_rating || 0,
      dominant_color_label: photo.my_color_label || null,
      color_labels: {},
    });

    const archive = archiver('zip', { zlib: { level: 9 } });
    const passthrough = new PassThrough();
    archive.pipe(passthrough);

    for (const photo of photos) {
      const baseFilename = filename_format === 'original'
        ? (photo.original_filename || photo.filename)
        : photo.filename;
      const xmpFilename = this.xmpGenerator.getXmpFilename(baseFilename);
      const xmpContent = this.xmpGenerator.generateXmp(project(photo), options);

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
        color_label: photo.dominant_color_label || null,
        color_labels: photo.color_labels || {},
        my_rating: photo.my_rating ?? null,
        my_color_label: photo.my_color_label || null,
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
