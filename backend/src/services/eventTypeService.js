/**
 * Event Type Service Layer
 * Handles all event type-related business logic
 *
 * @module services/eventTypeService
 */

const { db } = require('../database/db');
const { formatBoolean } = require('../utils/dbCompat');
const { hasColumnCached } = require('../utils/schemaCache');
const logger = require('../utils/logger');

/**
 * Get all event types
 * @param {Object} options - Filter options
 * @param {boolean} options.activeOnly - Only return active types
 * @returns {Promise<Array>} - Array of event types
 */
const getAllEventTypes = async (options = {}) => {
  const { activeOnly = false } = options;

  let query = db('event_types').select('*');

  if (activeOnly) {
    query = query.where('is_active', formatBoolean(true));
  }

  const types = await query.orderBy('display_order', 'asc');
  return types;
};

/**
 * Get active event types for dropdown/selection
 * @returns {Promise<Array>} - Array of active event types
 */
const getActiveEventTypes = async () => {
  return getAllEventTypes({ activeOnly: true });
};

/**
 * Get an event type by ID
 * @param {number} id - Event type ID
 * @returns {Promise<Object|null>}
 */
const getEventTypeById = async (id) => {
  const eventType = await db('event_types').where('id', id).first();
  return eventType || null;
};

/**
 * Get an event type by slug prefix
 * @param {string} slugPrefix - The slug prefix
 * @returns {Promise<Object|null>}
 */
const getEventTypeBySlugPrefix = async (slugPrefix) => {
  const eventType = await db('event_types')
    .where('slug_prefix', slugPrefix.toLowerCase())
    .first();
  return eventType || null;
};

/**
 * Check if a slug prefix is valid (exists in event_types or is a legacy type)
 * @param {string} slugPrefix - The slug prefix to validate
 * @returns {Promise<boolean>}
 */
const isValidEventType = async (slugPrefix) => {
  const normalized = slugPrefix.toLowerCase();

  // Check in database
  const eventType = await getEventTypeBySlugPrefix(normalized);
  if (eventType && eventType.is_active) {
    return true;
  }

  // Legacy fallback: Accept old hardcoded values for backward compatibility
  const legacyTypes = ['wedding', 'birthday', 'corporate', 'other'];
  return legacyTypes.includes(normalized);
};

/**
 * Get all valid slug prefixes (for validation)
 * @returns {Promise<string[]>}
 */
const getValidSlugPrefixes = async () => {
  const types = await db('event_types')
    .where('is_active', formatBoolean(true))
    .select('slug_prefix');

  return types.map(t => t.slug_prefix);
};

/**
 * Create a new event type
 * @param {Object} eventTypeData - Event type data
 * @returns {Promise<Object>} - Created event type
 */
const createEventType = async (eventTypeData) => {
  const {
    name,
    slug_prefix,
    emoji,
    theme_preset,
    theme_config,
    display_order
  } = eventTypeData;

  // Normalize slug_prefix
  const normalizedSlugPrefix = slug_prefix.toLowerCase().replace(/[^a-z0-9-]/g, '-');

  // Check for duplicate slug_prefix
  const existing = await getEventTypeBySlugPrefix(normalizedSlugPrefix);
  if (existing) {
    const error = new Error('An event type with this slug prefix already exists');
    error.code = 'DUPLICATE_SLUG_PREFIX';
    throw error;
  }

  // Get max display order if not provided
  let finalDisplayOrder = display_order;
  if (finalDisplayOrder === undefined || finalDisplayOrder === null) {
    const maxOrder = await db('event_types').max('display_order as max').first();
    finalDisplayOrder = (maxOrder?.max || 0) + 1;
  }

  const insertData = {
    name,
    slug_prefix: normalizedSlugPrefix,
    emoji: emoji || '📷',
    theme_preset: theme_preset || 'default',
    theme_config: theme_config ? JSON.stringify(theme_config) : null,
    display_order: finalDisplayOrder,
    is_system: false,
    is_active: true,
    created_at: new Date(),
    updated_at: new Date()
  };

  const insertResult = await db('event_types').insert(insertData).returning('id');
  const eventTypeId = insertResult[0]?.id || insertResult[0];

  return getEventTypeById(eventTypeId);
};

/**
 * Update an event type
 * @param {number} id - Event type ID
 * @param {Object} updates - Fields to update
 * @returns {Promise<Object>} - Updated event type
 */
const updateEventType = async (id, updates) => {
  const eventType = await getEventTypeById(id);
  if (!eventType) {
    const error = new Error('Event type not found');
    error.code = 'NOT_FOUND';
    throw error;
  }

  // Build update object
  const updateData = {};

  if (updates.name !== undefined) {
    updateData.name = updates.name;
  }

  if (updates.slug_prefix !== undefined) {
    const normalizedSlugPrefix = updates.slug_prefix.toLowerCase().replace(/[^a-z0-9-]/g, '-');

    // Check for duplicate (excluding current)
    const existing = await db('event_types')
      .where('slug_prefix', normalizedSlugPrefix)
      .whereNot('id', id)
      .first();

    if (existing) {
      const error = new Error('An event type with this slug prefix already exists');
      error.code = 'DUPLICATE_SLUG_PREFIX';
      throw error;
    }

    updateData.slug_prefix = normalizedSlugPrefix;
  }

  if (updates.emoji !== undefined) {
    updateData.emoji = updates.emoji;
  }

  if (updates.theme_preset !== undefined) {
    updateData.theme_preset = updates.theme_preset;
  }

  if (updates.theme_config !== undefined) {
    updateData.theme_config = updates.theme_config ? JSON.stringify(updates.theme_config) : null;
  }

  if (updates.display_order !== undefined) {
    updateData.display_order = updates.display_order;
  }

  if (updates.is_active !== undefined) {
    updateData.is_active = formatBoolean(updates.is_active);
  }

  updateData.updated_at = new Date();

  // A slug_prefix rename must CASCADE, or it silently orphans everything keyed on
  // the old slug: existing events/quotes (their event_type), and the per-type
  // pre-event reminder template (event_reminder_<slug>). Re-point them so a
  // rename behaves like a rename, not a detach. Atomic.
  const oldSlug = eventType.slug_prefix;
  const newSlug = updateData.slug_prefix;
  const slugChanged = newSlug !== undefined && newSlug !== oldSlug;

  if (!slugChanged) {
    await db('event_types').where('id', id).update(updateData);
    return getEventTypeById(id);
  }

  // Resolve schema lookups BEFORE opening the transaction — hasColumnCached
  // reads via the global db, and a global read inside a SQLite transaction
  // (single connection) deadlocks.
  const quotesHasEventType = await hasColumnCached('quotes', 'event_type');

  await db.transaction(async (trx) => {
    await trx('event_types').where('id', id).update(updateData);
    // Re-point existing documents from the old slug to the new one.
    const evCount = await trx('events').where('event_type', oldSlug).update({ event_type: newSlug });
    let qCount = 0;
    if (quotesHasEventType) {
      qCount = await trx('quotes').where('event_type', oldSlug).update({ event_type: newSlug });
    }
    // Carry the authored per-type reminder template along (subject/body follow the
    // rename). Guard: never clobber an existing target template for the new slug.
    const oldKey = `event_reminder_${oldSlug}`;
    const newKey = `event_reminder_${newSlug}`;
    let tplMoved = false;
    const src = await trx('email_templates').where({ template_key: oldKey }).first('id');
    const dst = await trx('email_templates').where({ template_key: newKey }).first('id');
    if (src && !dst) {
      await trx('email_templates').where({ template_key: oldKey }).update({ template_key: newKey });
      tplMoved = true;
    }
    logger.info('Event type slug renamed — cascaded references', {
      id, oldSlug, newSlug, events: evCount, quotes: qCount, reminderTemplateMoved: tplMoved,
    });
  });

  return getEventTypeById(id);
};

/**
 * Delete an event type
 * @param {number} id - Event type ID
 * @returns {Promise<Object>}
 */
const deleteEventType = async (id) => {
  const eventType = await getEventTypeById(id);
  if (!eventType) {
    const error = new Error('Event type not found');
    error.code = 'NOT_FOUND';
    throw error;
  }

  // Prevent deletion of system types
  if (eventType.is_system) {
    const error = new Error('Cannot delete system event types. You can deactivate them instead.');
    error.code = 'SYSTEM_TYPE';
    throw error;
  }

  // Check if any events use this type
  const eventsUsingType = await db('events')
    .where('event_type', eventType.slug_prefix)
    .count('id as count')
    .first();

  if (eventsUsingType && parseInt(eventsUsingType.count) > 0) {
    const error = new Error(`Cannot delete: ${eventsUsingType.count} events are using this type. Deactivate it instead or reassign those events.`);
    error.code = 'IN_USE';
    throw error;
  }

  await db('event_types').where('id', id).del();

  return { success: true, deleted: eventType };
};

/**
 * Reorder event types
 * @param {Array} orderedIds - Array of IDs in new order
 * @returns {Promise<Array>}
 */
const reorderEventTypes = async (orderedIds) => {
  await db.transaction(async (trx) => {
    for (let i = 0; i < orderedIds.length; i++) {
      await trx('event_types')
        .where('id', orderedIds[i])
        .update({ display_order: i + 1, updated_at: new Date() });
    }
  });

  return getAllEventTypes();
};

/**
 * Get event type info for slug generation
 * Returns the slug_prefix to use for a given event type identifier
 * @param {string} eventTypeIdentifier - Either an ID or slug_prefix
 * @returns {Promise<Object>} - Event type with slug_prefix and theme_preset
 */
const getEventTypeForSlug = async (eventTypeIdentifier) => {
  // Try to find by slug_prefix first
  let eventType = await getEventTypeBySlugPrefix(eventTypeIdentifier);

  if (eventType) {
    return eventType;
  }

  // Try by ID if numeric
  if (!isNaN(eventTypeIdentifier)) {
    eventType = await getEventTypeById(parseInt(eventTypeIdentifier));
    if (eventType) {
      return eventType;
    }
  }

  // Fallback for legacy types - return a compatible object
  const legacyDefaults = {
    wedding: { slug_prefix: 'wedding', theme_preset: 'elegantWedding', emoji: '💒' },
    birthday: { slug_prefix: 'birthday', theme_preset: 'birthdayFun', emoji: '🎂' },
    corporate: { slug_prefix: 'corporate', theme_preset: 'corporateTimeline', emoji: '🏢' },
    other: { slug_prefix: 'other', theme_preset: 'default', emoji: '📸' }
  };

  const normalized = eventTypeIdentifier.toLowerCase();
  if (legacyDefaults[normalized]) {
    return legacyDefaults[normalized];
  }

  // Default fallback
  return { slug_prefix: 'event', theme_preset: 'default', emoji: '📷' };
};

module.exports = {
  getAllEventTypes,
  getActiveEventTypes,
  getEventTypeById,
  getEventTypeBySlugPrefix,
  isValidEventType,
  getValidSlugPrefixes,
  createEventType,
  updateEventType,
  deleteEventType,
  reorderEventTypes,
  getEventTypeForSlug
};
