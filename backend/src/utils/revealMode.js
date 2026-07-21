/**
 * Reveal mode (#838): effective-visibility math, shared by the gallery
 * routes, the admin routes and the reveal scheduler.
 *
 * The gate is computed from the event row at request time — a scheduled
 * reveal opens EXACTLY at reveal_at even if the minutely scheduler (which
 * only stamps revealed_at durably and fires notifications) lags behind.
 */

/** Truthy check that survives SQLite 0/1 and Postgres booleans. */
function isTrue(value) {
  return value === true || value === 1 || value === '1';
}

/**
 * Parse a timestamp column that may arrive as a Date (Postgres), an ISO
 * string, or a millisecond number/number-string (SQLite stores knex Dates
 * as ms — `new Date("178…")` on that string would be Invalid Date and
 * silently keep the gallery hidden past its scheduled reveal).
 */
function toDate(value) {
  if (value instanceof Date) return value;
  if (typeof value === 'number') return new Date(value);
  const asNumber = Number(value);
  if (!Number.isNaN(asNumber) && String(value).trim() !== '') return new Date(asNumber);
  return new Date(value);
}

/**
 * Whether the gallery is currently hidden from plain guests.
 * Host/admin/slideshow/client access bypasses this at the route layer.
 */
function isGalleryHidden(event, now = new Date()) {
  if (!isTrue(event.reveal_mode)) return false;
  if (event.revealed_at) return false;
  if (event.reveal_at && toDate(event.reveal_at) <= now) return false;
  return true;
}

/**
 * Which access levels see the full gallery while it is hidden:
 * the live slideshow (the "surprise beamer" case), client access and
 * customer-portal-minted tokens (both are the host/customer reviewing
 * their own event — those tokens carry via:'customer' with NO accessLevel,
 * so accessLevel alone would misclassify them as guests) and the admin
 * preview.
 */
function bypassesReveal(req) {
  if (req.accessLevel === 'slideshow' || req.accessLevel === 'client') return true;
  if (req.viaCustomer) return true;
  // Lazy require avoids a cycle: middleware/gallery requires nothing from
  // here, but keeping the import local makes that permanent.
  const { isAdminPreview } = require('../middleware/gallery');
  return Boolean(isAdminPreview(req));
}

/** Route guard result: is THIS request blocked by reveal mode? */
function guestBlockedByReveal(req, now = new Date()) {
  return isGalleryHidden(req.event, now) && !bypassesReveal(req);
}

/**
 * Route guard: hard 403 for plain guests on photo/derivative/download
 * endpoints while the gallery is hidden. Photo IDs are sequential, so
 * gating only the listing would leave images probeable. Mount AFTER
 * verifyGalleryAccess (needs req.event / req.accessLevel).
 */
function blockHiddenGallery(req, res, next) {
  if (guestBlockedByReveal(req)) {
    return res.status(403).json({ error: 'Gallery is hidden until reveal', code: 'GALLERY_HIDDEN' });
  }
  next();
}

module.exports = { isGalleryHidden, bypassesReveal, guestBlockedByReveal, blockHiddenGallery };
