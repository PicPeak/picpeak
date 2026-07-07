/**
 * Event Service Layer
 * Handles all event-related business logic
 *
 * @module services/eventService
 */

const bcrypt = require('bcrypt');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs').promises;
const { db } = require('../database/db');
const logger = require('../utils/logger');
const { formatBoolean } = require('../utils/dbCompat');
const { hasColumnCached } = require('../utils/schemaCache');
const { validatePasswordInContext, getBcryptRounds } = require('../utils/passwordValidation');
const { buildShareLinkVariants } = require('./shareLinkService');
const { parseBooleanInput, parseStringInput } = require('../utils/parsers');
const eventTypeService = require('./eventTypeService');
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

const getStoragePath = () => process.env.STORAGE_PATH || path.join(__dirname, '../../../storage');

// Cache for schema detection
let customerColumnCache = null;

/**
 * Check if the database has the new customer_email column
 * @returns {Promise<boolean>}
 */
const hasCustomerContactColumns = async () => {
  if (customerColumnCache === true) {
    return true;
  }

  try {
    const hasColumn = await db.schema.hasColumn('events', 'customer_email');
    if (hasColumn) {
      customerColumnCache = true;
    }
    return hasColumn;
  } catch (error) {
    return false;
  }
};

/**
 * Map event for API response (normalize customer fields)
 * @param {Object} event - Database event object
 * @returns {Object} - Normalized event object
 */
const mapEventForApi = (event) => {
  if (!event || typeof event !== 'object') {
    return event;
  }

  const {
    host_name,
    host_email,
    customer_name,
    customer_email,
    ...rest
  } = event;

  return {
    ...rest,
    customer_name: customer_name ?? host_name ?? null,
    customer_email: customer_email ?? host_email ?? null
  };
};

/**
 * Generate a unique slug for an event
 * @param {string} eventType - Event type identifier (slug_prefix or legacy type)
 * @param {string} eventName
 * @param {string} eventDate
 * @returns {Promise<string>}
 */
const generateUniqueSlug = async (eventType, eventName, eventDate) => {
  // Get the slug_prefix from event type (supports both new dynamic types and legacy)
  const eventTypeInfo = await eventTypeService.getEventTypeForSlug(eventType);
  const slugPrefix = eventTypeInfo.slug_prefix || eventType;

  const processedName = eventName
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  const baseSlug = `${slugPrefix}-${processedName}-${eventDate}`;
  let slug = baseSlug;
  let counter = 1;

  while (await db('events').where({ slug }).first()) {
    slug = `${baseSlug}-${counter}`;
    counter++;
  }

  return slug;
};

/**
 * Create event storage folders
 * @param {string} slug - Event slug
 * @returns {Promise<string>} - Path to event folder
 */
const createEventFolders = async (slug) => {
  const storagePath = getStoragePath();
  const eventPath = path.join(storagePath, 'events/active', slug);
  await fs.mkdir(path.join(eventPath, 'collages'), { recursive: true });
  await fs.mkdir(path.join(eventPath, 'individual'), { recursive: true });
  return eventPath;
};

/**
 * Create a new event
 * @param {Object} eventData - Event data
 * @returns {Promise<Object>} - Created event
 */
const createEvent = async (eventData) => {
  const {
    event_type,
    event_name,
    event_date,
    customer_name,
    customer_email,
    admin_email,
    password,
    require_password = true,
    welcome_message,
    color_theme,
    expiration_days = 30,
    // Feedback settings
    feedback_enabled,
    allow_ratings,
    allow_likes,
    allow_comments,
    allow_favorites,
    require_name_email,
    moderate_comments,
    show_feedback_to_guests,
    // Upload settings
    allow_user_uploads,
    upload_category_id,
    // Photo cap
    photo_cap,
    // Migration 137 — calendar time fields. Defaults to full-day when
    // the caller (legacy create-event form) doesn't know about them.
    event_time_start,
    event_time_end,
    is_full_day
  } = eventData;

  const requirePassword = parseBooleanInput(require_password, true);
  const customerColumnsAvailable = await hasCustomerContactColumns();
  // Validate + normalise the calendar time triple up front so we throw
  // before bcrypt + folder creation if the payload is bad.
  const timeTriple = normaliseEventTimeTriple({
    event_time_start, event_time_end, is_full_day,
  });

  // Validate password if required
  if (requirePassword) {
    const passwordValidation = await validatePasswordInContext(password, 'gallery', {
      eventName: event_name
    });

    if (!passwordValidation.valid) {
      const error = new Error('Password does not meet security requirements');
      error.code = 'PASSWORD_INVALID';
      error.details = passwordValidation.errors;
      error.score = passwordValidation.score;
      error.feedback = passwordValidation.feedback;
      throw error;
    }
  }

  // Generate unique slug
  const slug = await generateUniqueSlug(event_type, event_name, event_date);

  // Generate share link
  const shareToken = crypto.randomBytes(16).toString('hex');
  const { shareUrl, shareLinkToStore } = await buildShareLinkVariants({ slug, shareToken });

  // Hash password
  const password_hash = requirePassword
    ? await bcrypt.hash(password, getBcryptRounds())
    : await bcrypt.hash(crypto.randomBytes(32).toString('hex'), getBcryptRounds());

  // Calculate expiration date
  const expires_at = new Date(event_date);
  expires_at.setDate(expires_at.getDate() + parseInt(expiration_days, 10));

  // Create folder structure
  await createEventFolders(slug);

  // Build insert data
  const insertData = {
    slug,
    event_type,
    event_name,
    event_date,
    ...(customerColumnsAvailable ? { customer_name, customer_email } : {}),
    host_name: customer_name,
    host_email: customer_email,
    admin_email,
    password_hash,
    welcome_message,
    color_theme,
    share_link: shareLinkToStore,
    share_token: shareToken,
    expires_at,
    require_password: formatBoolean(requirePassword),
    // Feedback settings
    feedback_enabled: feedback_enabled !== undefined ? formatBoolean(feedback_enabled) : undefined,
    allow_ratings: allow_ratings !== undefined ? formatBoolean(allow_ratings) : undefined,
    allow_likes: allow_likes !== undefined ? formatBoolean(allow_likes) : undefined,
    allow_comments: allow_comments !== undefined ? formatBoolean(allow_comments) : undefined,
    allow_favorites: allow_favorites !== undefined ? formatBoolean(allow_favorites) : undefined,
    require_name_email: require_name_email !== undefined ? formatBoolean(require_name_email) : undefined,
    moderate_comments: moderate_comments !== undefined ? formatBoolean(moderate_comments) : undefined,
    show_feedback_to_guests: show_feedback_to_guests !== undefined ? formatBoolean(show_feedback_to_guests) : undefined,
    // Upload settings
    allow_user_uploads: allow_user_uploads !== undefined ? formatBoolean(allow_user_uploads) : undefined,
    upload_category_id: upload_category_id || null,
    // Photo cap
    photo_cap: photo_cap || null
  };

  // Migration 137 — calendar time fields. Guarded by hasColumnCached so
  // installs that haven't applied 137 yet skip the columns silently
  // (per feedback_schema_drift_guards.md / feedback_cache_hasColumn_lookups.md).
  if (await hasColumnCached('events', 'is_full_day')) {
    insertData.event_time_start = timeTriple.event_time_start;
    insertData.event_time_end = timeTriple.event_time_end;
    insertData.is_full_day = formatBoolean(timeTriple.is_full_day);
  }

  // Remove undefined values
  Object.keys(insertData).forEach(key => {
    if (insertData[key] === undefined) {
      delete insertData[key];
    }
  });

  // Insert into database
  const insertResult = await db('events').insert(insertData).returning('id');
  const eventId = insertResult[0]?.id || insertResult[0];

  // Fire gallery.published — a gallery goes live the moment it's created (active
  // + share link). Best-effort; emit is fail-closed when the workflows flag is
  // off and never throws into the create path.
  try {
    await require('./workflows').emitWorkflowEvent('gallery.published', {
      entityType: 'event',
      entityId: eventId,
      payload: {
        eventId,
        slug,
        eventName: event_name,
        eventDate: event_date,
        customerEmail: customer_email || null,
        adminEmail: admin_email || null,
        galleryLink: shareUrl,
        expiresAt: expires_at,
      },
    });
  } catch (err) {
    logger.warn('Failed to emit gallery.published workflow event', { eventId, error: err.message });
  }

  return {
    id: eventId,
    slug,
    share_link: shareUrl,
    expires_at,
    require_password: requirePassword,
    customer_name,
    customer_email
  };
};

/**
 * Get all events with optional filtering
 * @param {Object} options - Filter options
 * @param {string} options.status - 'all', 'active', or 'archived'
 * @returns {Promise<Array>} - Array of events
 */
const getAllEvents = async (options = {}) => {
  const { status = 'all' } = options;

  let query = db('events').select('*');

  if (status === 'active') {
    query = query.where('is_active', formatBoolean(true));
  } else if (status === 'archived') {
    query = query.where('is_archived', formatBoolean(true));
  }

  const events = await query.orderBy('created_at', 'desc');

  // Add photo counts
  for (const event of events) {
    const photoCount = await db('photos').where('event_id', event.id).count('id as count').first();
    event.photo_count = photoCount.count;
  }

  return events.map(mapEventForApi);
};

/**
 * Get a single event by ID
 * @param {number} id - Event ID
 * @returns {Promise<Object|null>}
 */
const getEventById = async (id) => {
  const event = await db('events').where('id', id).first();
  return event ? mapEventForApi(event) : null;
};

/**
 * Get a single event by slug
 * @param {string} slug - Event slug
 * @returns {Promise<Object|null>}
 */
const getEventBySlug = async (slug) => {
  const event = await db('events').where('slug', slug).first();
  return event ? mapEventForApi(event) : null;
};

/**
 * Update an event
 * @param {number} id - Event ID
 * @param {Object} updates - Fields to update
 * @returns {Promise<Object>} - Updated event
 */
const updateEvent = async (id, updates) => {
  const customerColumnsAvailable = await hasCustomerContactColumns();

  // Don't allow updating certain fields
  delete updates.id;
  delete updates.slug;
  delete updates.created_at;
  delete updates.password_confirmation;

  // Handle legacy field names
  if (updates.host_name || updates.host_email) {
    throw new Error('host_name and host_email are no longer supported. Use customer_name and customer_email instead.');
  }

  // Handle customer name update
  if (updates.customer_name !== undefined) {
    const nextName = parseStringInput(updates.customer_name);
    if (nextName) {
      if (customerColumnsAvailable) {
        updates.customer_name = nextName;
      } else {
        delete updates.customer_name;
      }
      updates.host_name = nextName;
    } else {
      delete updates.customer_name;
    }
  }

  // Handle customer email update
  if (updates.customer_email !== undefined) {
    const nextEmail = parseStringInput(updates.customer_email);
    if (nextEmail) {
      if (customerColumnsAvailable) {
        updates.customer_email = nextEmail;
      } else {
        delete updates.customer_email;
      }
      updates.host_email = nextEmail;
    } else {
      delete updates.customer_email;
    }
  }

  // Handle require_password update
  if (updates.require_password !== undefined) {
    const requirePasswordUpdate = parseBooleanInput(updates.require_password, true);
    updates.require_password = formatBoolean(requirePasswordUpdate);

    // Get current event to check password requirements
    const event = await db('events').where('id', id).first();
    const currentRequirePassword = parseBooleanInput(event.require_password, true);

    // If enabling password and it was previously disabled, require a new password
    if (requirePasswordUpdate === true && !currentRequirePassword && !updates.password) {
      throw new Error('Password must be provided when enabling password requirement.');
    }

    // If disabling password, generate a random hash
    if (requirePasswordUpdate === false && currentRequirePassword) {
      updates.password_hash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), getBcryptRounds());
    }
  }

  // Handle password update
  if (updates.password) {
    updates.password_hash = await bcrypt.hash(updates.password, getBcryptRounds());
    delete updates.password;
  }

  // Migration 137 — calendar time fields. We re-normalise the triple
  // ONLY when at least one of the three fields was supplied; otherwise
  // leave the row's current values alone. is_full_day=true forces both
  // times to null regardless of what was supplied.
  const timeFieldsTouched = (
    updates.event_time_start !== undefined
    || updates.event_time_end !== undefined
    || updates.is_full_day !== undefined
  );
  if (timeFieldsTouched) {
    if (await hasColumnCached('events', 'is_full_day')) {
      const triple = normaliseEventTimeTriple({
        event_time_start: updates.event_time_start,
        event_time_end: updates.event_time_end,
        is_full_day: updates.is_full_day,
      });
      updates.event_time_start = triple.event_time_start;
      updates.event_time_end = triple.event_time_end;
      updates.is_full_day = formatBoolean(triple.is_full_day);
    } else {
      // Un-migrated install — drop the fields silently.
      delete updates.event_time_start;
      delete updates.event_time_end;
      delete updates.is_full_day;
    }
  }

  await db('events').where('id', id).update(updates);

  return { success: true };
};

/**
 * Soft delete an event (mark as inactive)
 * @param {number} id - Event ID
 * @returns {Promise<Object>}
 */
const deleteEvent = async (id) => {
  await db('events').where('id', id).update({ is_active: formatBoolean(false) });
  return { success: true };
};

/**
 * Extend event expiration
 * @param {number} id - Event ID
 * @param {number} days - Days to extend
 * @returns {Promise<Object>}
 */
const extendExpiration = async (id, days) => {
  const event = await db('events').where('id', id).first();
  if (!event) {
    throw new Error('Event not found');
  }

  const newExpiration = new Date(event.expires_at);
  newExpiration.setDate(newExpiration.getDate() + days);

  await db('events').where('id', id).update({
    expires_at: newExpiration,
    is_active: formatBoolean(true) // Reactivate if expired
  });

  return { expires_at: newExpiration };
};

module.exports = {
  // Core CRUD
  createEvent,
  getAllEvents,
  getEventById,
  getEventBySlug,
  updateEvent,
  deleteEvent,
  extendExpiration,

  // Utilities
  mapEventForApi,
  hasCustomerContactColumns,
  generateUniqueSlug,
  createEventFolders,
  // Calendar time triple normaliser (migration 137). Exported so the
  // inline adminEvents POST/PUT (which doesn't go through createEvent)
  // can share the validation contract.
  normaliseEventTimeTriple
};
