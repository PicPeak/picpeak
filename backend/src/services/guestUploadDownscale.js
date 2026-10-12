'use strict';

/**
 * Optional downscale of guest uploads (issue 1733).
 *
 * events.guest_upload_max_edge is the longest edge, in pixels, the guest's
 * browser scales JPEG, PNG and WebP photos to before sending them; NULL sends
 * originals. The server stores whatever arrives: the setting saves bandwidth
 * and storage, it is not a limit a client is held to.
 */
const GUEST_UPLOAD_MIN_EDGE = 1024;
const GUEST_UPLOAD_MAX_EDGE = 16384;

/** A value the event update accepts for the column (null clears it). */
function isGuestUploadMaxEdge(value) {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+$/.test(value))) return false;
  const edge = Number(value);
  return Number.isInteger(edge) && edge >= GUEST_UPLOAD_MIN_EDGE && edge <= GUEST_UPLOAD_MAX_EDGE;
}

/** The edge the upload dialog applies, or null for originals. */
function guestUploadMaxEdgeOf(event) {
  const edge = Number(event && event.guest_upload_max_edge);
  return Number.isInteger(edge) && edge > 0 ? edge : null;
}

/**
 * The capture date the browser read from a photo before scaling it down: the
 * canvas re-encode drops EXIF, so the date travels as a form field. It is the
 * raw EXIF DateTimeOriginal text, "YYYY:MM:DD HH:MM:SS", and is read as
 * server-local wall time exactly as exifr reads the tag from a file, so a
 * scaled photo sorts where its original would have.
 *
 * The value is the client's word: only this exact shape, a real calendar
 * date, and the range extractCaptureDate accepts (after 1990, not in the
 * future). Anything else is null.
 */
const EXIF_DATE = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;
const MIN_CAPTURE_DATE = new Date('1990-01-01');

function parseClientCaptureDate(raw, now = new Date()) {
  if (typeof raw !== 'string') return null;
  const match = EXIF_DATE.exec(raw);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const date = new Date(year, month - 1, day, hour, minute, second);
  // Date() rolls 02-30 or 25:00 over instead of refusing it.
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day
    || date.getHours() !== hour || date.getMinutes() !== minute || date.getSeconds() !== second) {
    return null;
  }
  return date > MIN_CAPTURE_DATE && date <= now ? date : null;
}

module.exports = {
  GUEST_UPLOAD_MIN_EDGE,
  GUEST_UPLOAD_MAX_EDGE,
  isGuestUploadMaxEdge,
  guestUploadMaxEdgeOf,
  parseClientCaptureDate,
};
