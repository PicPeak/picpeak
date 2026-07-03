const { db } = require('../database/db');

// Default date format settings
const DEFAULT_FORMAT = {
  format: 'DD/MM/YYYY',
  locale: 'en-GB'
};

// Format date based on system settings
async function formatDate(date, language = 'en') {
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
          console.warn('Failed to parse date format setting:', e.message);
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
      console.error('Invalid date provided to formatDate:', date);
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
      return dateObj.toLocaleDateString(locale, {
        month: '2-digit',
        day: '2-digit',
        year: 'numeric'
      });
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
      // Use long format as fallback
      return dateObj.toLocaleDateString(locale, {
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      });
    }
  } catch (error) {
    console.error('Error formatting date:', error);
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