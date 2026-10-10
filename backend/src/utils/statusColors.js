/**
 * Status colours (Branding › Colours): the one hue per meaning that badges,
 * notices and status chips derive their tints from, admin and public alike.
 * Stored as branding_status_colors = { success, warning, danger, info, storno }.
 * A missing key means "use the built-in default" (frontend tokens.css), so
 * only what the studio actually picked is stored.
 */

const STATUS_KEYS = ['success', 'warning', 'danger', 'info', 'storno'];
const HEX6 = /^#[0-9a-f]{6}$/i;

/** Keeps the known keys whose value is a #rrggbb colour; drops the rest. */
function normalizeStatusColors(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  for (const key of STATUS_KEYS) {
    const color = value[key];
    if (typeof color === 'string' && HEX6.test(color.trim())) out[key] = color.trim().toLowerCase();
  }
  return out;
}

module.exports = { STATUS_KEYS, normalizeStatusColors };
