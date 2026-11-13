const { db } = require('../database/db');
const logger = require('./logger');

// Default date format settings
const DEFAULT_FORMAT = {
  format: 'DD/MM/YYYY',
  locale: 'en-GB'
};

const LANGUAGE_LOCALES = { es: 'es-ES', fr: 'fr-FR', nl: 'nl-NL', ru: 'ru-RU', sl: 'sl-SI' };

// Format date based on system settings. `monthNames: true` names the month
// of a long date in every app language, not only de and pt (the link preview,
// issue 2489). Emails leave it off: some reuse one formatted date for
// recipients in another language.
async function formatDate(date, language = 'en', { monthNames = false } = {}) {
  try {
    // Get date format setting from database
    const setting = await db('app_settings').where('setting_key', 'general_date_format').first();
    let dateConfig = DEFAULT_FORMAT;
    
    if (setting && setting.setting_value) {
      // Handle both string and object values
      if (typeof setting.setting_value === 'string') {
        try {
          dateConfig = JSON.parse(setting.setting_value);
        } catch (e) {
          logger.warn('Failed to parse date format setting:', e.message);
          dateConfig = DEFAULT_FORMAT;
        }
      } else {
        dateConfig = setting.setting_value;
      }
    }
    
    // Ensure proper date parsing
    let dateObj;
    if (date instanceof Date) {
      dateObj = date;
    } else if (typeof date === 'string') {
      // For date strings like "2025-07-16", parse as local date to avoid timezone issues
      if (date.match(/^\d{4}-\d{2}-\d{2}$/)) {
        // Parse YYYY-MM-DD format as local date
        const [year, month, day] = date.split('-').map(num => parseInt(num, 10));
        dateObj = new Date(year, month - 1, day);
      } else {
        dateObj = new Date(date);
      }
    } else {
      dateObj = new Date(date);
    }
    
    // Check if date is valid
    if (isNaN(dateObj.getTime())) {
      logger.error('Invalid date provided to formatDate:', date);
      throw new Error('Invalid date');
    }
    
    // Use appropriate locale based on language
    let locale = dateConfig.locale || 'en-GB';
    if (language === 'de') {
      locale = 'de-DE';
    } else if (language === 'pt') {
      locale = 'pt-BR';
    } else if (language === 'en' && dateConfig.format === 'MM/DD/YYYY') {
      locale = 'en-US';
    }
    
    // Format based on the configured format
    switch (dateConfig.format) {
    case 'MM/DD/YYYY':
      // Spelled out: a German or Portuguese locale would put the day first
      // and turn 11/10 into 10.11 or 10/11, a different date for a reader of
      // the configured order.
      return `${String(dateObj.getMonth() + 1).padStart(2, '0')}/${String(dateObj.getDate()).padStart(2, '0')}/${dateObj.getFullYear()}`;
    case 'DD/MM/YYYY':
      return dateObj.toLocaleDateString(locale, {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric'
      });
    case 'YYYY-MM-DD':
      return dateObj.toISOString().split('T')[0];
    case 'DD.MM.YYYY':
      return dateObj.toLocaleDateString('de-DE', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric'
      });
    default:
      // Use long format as fallback. Only here, because a locale also sets
      // the field order of the numeric formats above.
      return dateObj.toLocaleDateString((monthNames && LANGUAGE_LOCALES[language]) || locale, {
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      });
    }
  } catch (error) {
    logger.error('Error formatting date:', error);
    // Fallback to basic formatting
    return date instanceof Date ? date.toLocaleDateString() : new Date(date).toLocaleDateString();
  }
}

/**
 * Sync DD.MM.YYYY formatter used by quote / invoice / contract render
 * contexts. Unlike `formatDate` above, this never consults app_settings
 * — it's intended for fixed-format use inside templates already rendered
 * for a specific document type. Three services used to ship a local
 * copy each; this is the single source.
 *
 * - falsy input → empty string (template's {{#if ...}} block hides)
 * - invalid date → the original value coerced to String (defensive
 *   passthrough; matches the prior behaviour of the three local copies)
 */
function formatShortDate(value) {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}.${mm}.${d.getFullYear()}`;
}

module.exports = {
  formatDate,
  formatShortDate,
};