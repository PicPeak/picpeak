/**
 * XMP Sidecar File Generator
 * Generates Adobe XMP metadata files for photos with guest feedback
 */

const { COLOR_LABEL_TO_XMP, dominantColorLabel } = require('../constants/colorLabels');

class XmpGenerator {
  /**
   * Generate XMP sidecar content for a photo
   * @param {Object} photo - Photo object with feedback data
   * @param {Object} options - Generation options
   * @returns {string} XMP file content
   */
  generateXmp(photo, options = {}) {
    const {
      include_rating = true,
      include_label = true,
      include_description = true,
      include_keywords = true
    } = options;

    const rating = include_rating ? this.mapRating(photo.average_rating) : 0;
    const label = include_label ? this.mapLabel(photo) : null;

    const descriptionXml = include_description ? this.generateDescription(photo) : '';
    const keywordsXml = include_keywords ? this.generateKeywords(photo) : '';

    return `<?xml version="1.0" encoding="UTF-8"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="PicPeak Export">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about=""
      xmlns:xmp="http://ns.adobe.com/xap/1.0/"
      xmlns:xmpMM="http://ns.adobe.com/xap/1.0/mm/"
      xmlns:dc="http://purl.org/dc/elements/1.1/"
      xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/"
      xmlns:Iptc4xmpCore="http://iptc.org/std/Iptc4xmpCore/1.0/xmlns/"
      xmp:Rating="${rating}"${label ? `
      xmp:Label="${label}"` : ''}>
      ${descriptionXml}
      ${keywordsXml}
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>`;
  }

  /**
   * Map PicPeak average rating to XMP 1-5 rating
   * @param {number} avgRating - Average rating (0-5, decimal)
   * @returns {number} XMP rating (0-5, integer)
   */
  mapRating(avgRating) {
    if (!avgRating || avgRating === 0) return 0;
    if (avgRating >= 4.5) return 5;
    if (avgRating >= 3.5) return 4;
    if (avgRating >= 2.5) return 3;
    if (avgRating >= 1.5) return 2;
    return 1;
  }

  /**
   * Resolve the photo's XMP colour label.
   *
   * A real colour label the client set while proofing (#1044) always wins:
   * that is the whole point of using Lightroom's colour set, and it is an
   * explicit choice rather than something inferred. Only when a photo has no
   * label does this fall back to the historical rating-derived mapping, so
   * exports for events that never enabled colour labels are unchanged.
   *
   * @param {Object} photo - photo row, may carry dominant_color_label
   * @returns {string|null} XMP label colour
   */
  mapLabel(photo) {
    // Tolerate being handed a bare rating: this used to take one, and
    // callers outside the export service may still do so.
    if (typeof photo === 'number' || photo === null || photo === undefined) {
      return this.mapRatingToLabel(photo);
    }

    const colorLabel = photo.dominant_color_label
      || dominantColorLabel(photo.color_labels);
    if (colorLabel && COLOR_LABEL_TO_XMP[colorLabel]) {
      return COLOR_LABEL_TO_XMP[colorLabel];
    }

    return this.mapRatingToLabel(photo.average_rating);
  }

  /**
   * The pre-#1044 mapping: infer a colour from the average star rating.
   * @param {number} avgRating - Average rating
   * @returns {string|null} XMP label color
   */
  mapRatingToLabel(avgRating) {
    if (!avgRating || avgRating === 0) return null;
    if (avgRating >= 4.5) return 'Red';      // Top picks
    if (avgRating >= 3.5) return 'Yellow';   // Good
    if (avgRating >= 2.5) return 'Green';    // Average
    if (avgRating >= 1.5) return 'Blue';     // Below average
    return 'Purple';                          // Low
  }

  /**
   * Generate XMP description element
   * @param {Object} photo - Photo object
   * @returns {string} Description XML
   */
  generateDescription(photo) {
    const rating = photo.average_rating ? parseFloat(photo.average_rating).toFixed(1) : '0';
    const likes = photo.like_count || 0;
    const favorites = photo.favorite_count || 0;

    const colorLabel = photo.dominant_color_label || dominantColorLabel(photo.color_labels);
    const colorPart = colorLabel ? `, ${colorLabel} label` : '';
    const desc = `PicPeak Guest Feedback: ${rating} stars, ${likes} likes, ${favorites} favorites${colorPart}`;

    return `<dc:description>
        <rdf:Alt>
          <rdf:li xml:lang="x-default">${this.escapeXml(desc)}</rdf:li>
        </rdf:Alt>
      </dc:description>`;
  }

  /**
   * Generate XMP keywords element
   * @param {Object} photo - Photo object
   * @returns {string} Keywords XML
   */
  generateKeywords(photo) {
    const keywords = ['picpeak-export'];

    if (photo.average_rating >= 4) {
      keywords.push('guest-pick');
    }

    if (photo.average_rating >= 4.5) {
      keywords.push('top-rated');
    }

    if (photo.like_count >= 5) {
      keywords.push('popular');
    }

    if (photo.favorite_count > 0) {
      keywords.push('favorited');
    }

    // A searchable keyword for the client's colour choice (#1044) — Lightroom
    // can filter on xmp:Label directly, Bridge and Capture One users often
    // find keywords easier.
    const colorLabel = photo.dominant_color_label || dominantColorLabel(photo.color_labels);
    if (colorLabel) {
      keywords.push(`color-${colorLabel}`);
    }

    if (photo.category_name) {
      keywords.push(this.sanitizeKeyword(photo.category_name));
    }

    return `<dc:subject>
        <rdf:Bag>
          ${keywords.map(k => `<rdf:li>${this.escapeXml(k)}</rdf:li>`).join('\n          ')}
        </rdf:Bag>
      </dc:subject>`;
  }

  /**
   * Escape special XML characters
   * @param {string} str - Input string
   * @returns {string} Escaped string
   */
  escapeXml(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  /**
   * Sanitize keyword for XMP
   * @param {string} keyword - Raw keyword
   * @returns {string} Sanitized keyword
   */
  sanitizeKeyword(keyword) {
    return keyword
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
  }

  /**
   * Get XMP filename from photo filename
   * @param {string} photoFilename - Photo filename
   * @returns {string} XMP filename
   */
  getXmpFilename(photoFilename) {
    return photoFilename.replace(/\.[^.]+$/, '.xmp');
  }
}

module.exports = { XmpGenerator };
