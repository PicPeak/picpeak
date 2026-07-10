/**
 * Formatters for email content and other text transformations
 */

// HTML-escape user-supplied text so it can be safely embedded in an email
// HTML body. Used by formatWelcomeMessage so the resulting <br />-separated
// HTML is safe even when the message contains < or > characters.
function escapeHtml(text) {
  if (text === null || text === undefined) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Convert plain text line breaks to HTML line breaks
 * @param {string} text - The text to format
 * @returns {string} - Text with HTML line breaks
 */
function nl2br(text) {
  if (!text) return '';

  // Normalize line endings
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // Convert newlines to <br> tags
  return text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .join('<br />');
}

/**
 * Format welcome message for email templates. Escapes the input first so
 * HTML metacharacters in admin-supplied text never reach the recipient's
 * mail client unescaped, then converts newlines to <br /> for rendering.
 * @param {string} message - The welcome message
 * @returns {string} - Escaped HTML with <br /> line breaks
 */
function formatWelcomeMessage(message) {
  if (!message || message.trim() === '') {
    return '';
  }

  return nl2br(escapeHtml(message));
}

module.exports = {
  escapeHtml,
  nl2br,
  formatWelcomeMessage
};
