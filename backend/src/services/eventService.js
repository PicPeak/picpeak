/**
 * Event Service Layer
 * The event calendar time validator and a createEvent entry point that
 * delegates to eventCreationService.
 *
 * @module services/eventService
 */

const { parseBooleanInput, parseStringInput } = require('../utils/parsers');
const { AppError } = require('../utils/errors');

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Coerce + validate the (event_time_start, event_time_end, is_full_day)
 * triple from a payload. Migration 137 introduced these columns on the
 * events table. Contract:
 *   - is_full_day defaults to true when undefined (preserves legacy
 *     callers that don't know about the new fields).
 *   - is_full_day=true forces both times to null regardless of what
 *     was supplied (full-day events never carry HH:MM).
 *   - is_full_day=false requires both times in HH:MM 24h form, and
 *     `end > start` lexicographically (string compare is safe for the
 *     5-char HH:MM format).
 * Throws AppError 400 on failure. Returns a normalised
 * { event_time_start, event_time_end, is_full_day } triple suitable
 * for direct DB write (boolean still coerced via formatBoolean at the
 * write site).
 */
function normaliseEventTimeTriple({ event_time_start, event_time_end, is_full_day }) {
  const isFullDay = is_full_day === undefined ? true : parseBooleanInput(is_full_day, true);
  if (isFullDay) {
    return { event_time_start: null, event_time_end: null, is_full_day: true };
  }
  const start = parseStringInput(event_time_start);
  const end = parseStringInput(event_time_end);
  if (!start || !TIME_RE.test(start)) {
    throw new AppError('event_time_start must be HH:MM (24h)', 400, 'EVENT_TIME_INVALID');
  }
  if (!end || !TIME_RE.test(end)) {
    throw new AppError('event_time_end must be HH:MM (24h)', 400, 'EVENT_TIME_INVALID');
  }
  if (start >= end) {
    throw new AppError('event_time_end must be after event_time_start', 400, 'EVENT_TIME_RANGE');
  }
  return { event_time_start: start, event_time_end: end, is_full_day: false };
}

/**
 * Create a new event
 * @param {Object} eventData - Event data
 * @returns {Promise<Object>} - Created event
 */
const createEvent = async (eventData, options = {}) => {
  return require('./eventCreationService').createEvent(eventData, {
    ...options,
    actor: options.actor || (eventData.created_by ? { id: eventData.created_by } : undefined),
  });
};

module.exports = {
  createEvent,
  // Calendar time triple normaliser (migration 137). Shared by the admin
  // PUT, eventCreationValidation and eventCreationService so every write
  // path uses one validation contract.
  normaliseEventTimeTriple
};
