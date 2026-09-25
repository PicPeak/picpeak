// Extracted verbatim from the original routes/adminEvents.js (see ./index.js).
// Exports a register function; ./index.js calls the sub-routers in the original
// registration order so Express route matching is unchanged.

const { body, validationResult } = require('express-validator');
const { db, logActivity } = require('../../database/db');
const { formatBoolean } = require('../../utils/dbCompat');

const { adminAuth } = require('../../middleware/auth');
const { requirePermission, userHasAllPermissions, userHasAnyPermission } = require('../../middleware/permissions');
const { IDENTITY_PRESERVING_NORMALIZE_EMAIL } = require('../../utils/emailNormalization');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const { escapeLikePattern, likeWithEscape } = require('../../utils/sqlSecurity');
const { validatePasswordInContext, getBcryptRounds } = require('../../utils/passwordValidation');
const logger = require('../../utils/logger');
const { sanitizeForLog, sanitizeValidationErrors } = require('../../utils/sanitizeForLog');
const { errorResponse, safeValidationErrors } = require('../../utils/routeHelpers');
const { isUniqueViolation } = require('../../utils/dbErrors');
const { buildShareLinkVariants } = require('../../services/shareLinkService');
const { parseBooleanInput } = require('../../utils/parsers');
const eventTypeService = require('../../services/eventTypeService');
const { normaliseEventTimeTriple } = require('../../services/eventService');
const { hasColumnCached } = require('../../utils/schemaCache');
const { requireEventOwnership, scopeEventsListQuery, withoutForeignEventSecrets, scopeEventsQuery } = require('../../middleware/ownership');

const { galleryPasswordColumns, dropCopiesIfStorageOff } = require('../../utils/galleryPasswordVault');
const { credentialChangeColumns, sameAsStored } = require('../../utils/galleryCredentialCutoff');

const { getFrontendBaseUrl, getAbsoluteFrontendUrl } = require('../../utils/frontendUrl');
const downloadZipService = require('../../services/downloadZipService');
const { KEYBIND_MODES } = require('../../services/feedbackDefaults');
const { GUEST_NAME_MODES } = require('../../services/photoCredit');
const { validateHeroImageAnchor, getCustomerNameFromPayload, getCustomerEmailFromPayload, getCustomerPhoneFromPayload, isPhoneFieldEnabled, mapEventForApi, hasCustomerContactColumns, deleteEventCascade } = require('./helpers');

// Client PIN floor. The PIN guards the client review page and used to accept
// any string, one character included. Six is the least that the login
// lockout makes worth guessing at. An empty string keeps its meaning: "no
// client password" on create, "leave it alone" on update. Existing events
// are not touched; only a submitted value is checked, before it is hashed.
const CLIENT_PASSWORD_MIN_LENGTH = 6;
const validateClientPassword = (value) => {
  if (typeof value !== 'string') throw new Error('Client password must be a string');
  if (value.length > 0 && value.length < CLIENT_PASSWORD_MIN_LENGTH) {
    throw new Error(`Client password must be at least ${CLIENT_PASSWORD_MIN_LENGTH} characters`);
  }
  return true;
};

/**
 * `events.slug` is UNIQUE, and both routes that mint one do a read-then-insert
 * (`while (await db('events').where({ slug }).first())`) — a check two
 * concurrent requests for the same name + date can both pass. The loser's
 * INSERT then raises the unique violation, which surfaced as a raw 500 with
 * "duplicate key value violates unique constraint events_slug_unique".
 *
 * Detect that one constraint specifically so the client gets an actionable
 * 409 instead. Deliberately narrower than isUniqueViolation alone: the events
 * table carries other unique columns (share_token), and a loose message test
 * would misfire because knex prefixes the whole INSERT — which always mentions
 * `slug` — to err.message.
 */
function isDuplicateSlugError(error) {
  if (!isUniqueViolation(error)) return false;
  // Postgres names the constraint; sqlite names the offending column.
  if (error.constraint) return /slug/i.test(error.constraint);
  return /unique constraint failed:.*\bevents\.slug\b/i.test(String(error.message || ''));
}

const DUPLICATE_SLUG_RESPONSE = {
  error: 'An event with this name already exists. Change the event name or date and try again.',
  code: 'EVENT_SLUG_TAKEN',
};

/**
 * Validate a gallery password the admin re-typed, against the SAME policy
 * event creation applies.
 *
 * Both the publish dialog (#627) and the send-later route (#1235) re-hash
 * `password_hash` from a plaintext the admin types again, and both validated
 * it with nothing but express-validator's `isLength({ min: 6 })`. So the
 * configured complexity — moderate by default — governed creation and reset
 * while these two doors accepted `aaaaaa` and made it the live password.
 *
 * Fixed in one place and for both, deliberately. Fixing only the newer route
 * would have made a quiet-publish password valid at publish time and rejected
 * by send-later, leaving the admin unable to mail a gallery that is already
 * live under that exact password.
 *
 * Returns null when the password passes; otherwise the response body to send.
 */
async function checkGalleryPasswordPolicy(password, eventName) {
  const result = await validatePasswordInContext(password, 'gallery', { eventName });
  if (result.valid) return null;
  return {
    error: 'Password does not meet security requirements',
    details: result.errors,
    score: result.score,
    feedback: result.feedback,
  };
}

/**
 * Can this assigned customer account actually receive — and act on — the
 * gallery notice? (#1235)
 *
 * Shared by publish, by the send-later route, and mirrored by the UI that
 * decides whether to offer the button at all. All four have to agree, or the
 * admin gets an action that 400s, or worse, one that reports success for a
 * notice nobody can use.
 *
 * - `is_active`: compared loosely because SQLite stores it as 0/1 and a
 *   strict `!== false` lets 0 through.
 * - `can_sign_in`: a PASSIVE customer (password_hash IS NULL — see
 *   customerAccountsService.createDirect) is a real, active account that has
 *   simply never been invited. customer_gallery_assigned links to
 *   /customer/dashboard, and customerAuth rejects login without a hash, so
 *   mailing one sends a link to a door that will not open. Excluded here
 *   rather than mailed, because a silent non-delivery the admin believes
 *   succeeded is worse than a visible refusal. Sending them an invitation
 *   instead is the better answer, and a separate feature.
 * - the column is emitted by a raw SQL predicate, so it arrives as a boolean
 *   on Postgres and 0/1 on SQLite; `== false` and `=== 0` cover both, and
 *   undefined (older callers) stays permissive.
 */
function canReceiveGalleryNotice(account) {
  if (!account || !account.email) return false;
  if (account.is_active === false || account.is_active === 0) return false;
  if (account.can_sign_in === false || account.can_sign_in === 0) return false;
  return true;
}

/**
 * Queue the gallery_created email for an event (#1235).
 *
 * Shared by publish and by the send-later route, because the two must produce
 * an identical email — an operator who publishes quietly and sends the mail a
 * week later should not get a subtly different message than one who published
 * loudly.
 *
 * The password is why this needs an argument at all: `password_hash` is a
 * hash, so the plaintext exists only in the request the admin just typed it
 * into (#627). Without one the email carries the legacy sentinel, exactly as an
 * API-only publish has always done.
 *
 * @returns {Promise<boolean>} false when the event has no inline recipient
 */
async function queueGalleryCreatedEmail(event, { password, requirePassword } = {}) {
  const customerEmail = event.customer_email || event.host_email;
  if (!customerEmail) return false;

  const customerName = event.customer_name || event.host_name;
  const frontendBase = await getFrontendBaseUrl();
  const { shareUrl } = await buildShareLinkVariants({
    slug: event.slug, shareToken: event.share_token,
  });

  let galleryPasswordForEmail;
  if (!requirePassword) {
    galleryPasswordForEmail = 'No password required';
  } else if (password) {
    galleryPasswordForEmail = password;
  } else {
    galleryPasswordForEmail = '(set at creation)';
  }

  await db('email_queue').insert({
    event_id: event.id,
    recipient_email: customerEmail,
    email_type: 'gallery_created',
    email_data: JSON.stringify({
      customer_name: customerName,
      customer_email: customerEmail,
      host_name: customerName || customerEmail.split('@')[0],
      event_name: event.event_name,
      event_date: event.event_date,
      gallery_link: shareUrl || `${frontendBase}/gallery/${event.slug}`,
      gallery_password: galleryPasswordForEmail,
      expiry_date: event.expires_at ? new Date(event.expires_at).toISOString() : null,
      welcome_message: event.welcome_message || ''
    }),
    status: 'pending',
    created_at: new Date()
  });
  return true;
}

module.exports = (router) => {

  // Create new event
  router.post('/', adminAuth, requirePermission('events.create'), [
    body('event_type').notEmpty().trim().custom(async (value) => {
      const isValid = await eventTypeService.isValidEventType(value);
      if (!isValid) {
        throw new Error('Invalid event type');
      }
      return true;
    }),
    body('event_name').notEmpty().trim(),
    body('event_date').optional({ values: 'falsy' }).isDate(),
    // Migration 137 — calendar time fields.
    body('event_time_start').optional({ values: 'falsy' }).matches(/^([01]\d|2[0-3]):[0-5]\d$/)
      .withMessage('event_time_start must be HH:MM 24h'),
    body('event_time_end').optional({ values: 'falsy' }).matches(/^([01]\d|2[0-3]):[0-5]\d$/)
      .withMessage('event_time_end must be HH:MM 24h'),
    body('is_full_day').optional().isBoolean().toBoolean(),
    body('customer_name').optional().trim(),
    body('customer_email').optional({ values: 'falsy' }).isEmail().normalizeEmail(IDENTITY_PRESERVING_NORMALIZE_EMAIL),
    body('customer_phone').optional({ nullable: true, checkFalsy: true })
      .isString().trim()
      .isLength({ max: 32 }).withMessage('Phone number must be at most 32 characters'),
    body('admin_email').optional({ values: 'falsy' }).isEmail().normalizeEmail(IDENTITY_PRESERVING_NORMALIZE_EMAIL),
    body('require_password').optional().isBoolean(),
    body('password').optional().isString().custom((value, { req }) => {
      const input = req.body.require_password;
      const normalizeBoolean = (val, defaultValue = true) => {
        if (val === undefined || val === null) return defaultValue;
        if (typeof val === 'boolean') return val;
        if (typeof val === 'number') return val !== 0;
        if (typeof val === 'string') {
          const normalized = val.trim().toLowerCase();
          if (['false', '0', 'no', 'off'].includes(normalized)) return false;
          if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
        }
        return defaultValue;
      };

      const requirePassword = normalizeBoolean(input, true);
      if (!requirePassword) {
        return true;
      }
      if (typeof value !== 'string' || value.trim().length < 6) {
        throw new Error('Password must be at least 6 characters long');
      }
      return true;
    }),
    body('expiration_days').isInt({ min: 1, max: 365 }).optional(),
    body('welcome_message').optional().trim(),
    body('color_theme').optional().trim(),
    body('allow_user_uploads').optional().isBoolean().toBoolean(),
    body('upload_category_id').optional({ nullable: true, checkFalsy: true }).isInt(),
    // Uploader names (#1561).
    body('guest_name_mode').optional().isIn(GUEST_NAME_MODES),
    body('show_credits_to_guests').optional().isBoolean().toBoolean(),
    body('allow_downloads').optional().isBoolean(),
    body('disable_right_click').optional().isBoolean(),
    body('enable_devtools_protection').optional().isBoolean(),
    // Image security. PUT /:id has validated these all along; create
    // accepted none of them, so a value sent here used to be dropped on the
    // floor and the column default applied instead (#1296).
    body('protection_level').optional().not().isArray().isIn(['basic', 'standard', 'enhanced', 'maximum']),
    body('use_canvas_rendering').optional().not().isArray().isBoolean().toBoolean(),
    body('image_quality').optional().not().isArray().isInt({ min: 1, max: 100 }).toInt(),
    body('watermark_downloads').optional().isBoolean(),
    body('watermark_text').optional().trim(),
    // #328 follow-up: per-event opt-in for presigned-URL "Download All".
    // Bypasses watermarks; admin must enable knowingly.
    // Feedback sub-toggles (#1044). Optional: omitting them inherits the
    // global Settings > Events defaults.
    body('allow_ratings').optional().isBoolean(),
    body('allow_likes').optional().isBoolean(),
    body('allow_comments').optional().isBoolean(),
    body('allow_favorites').optional().isBoolean(),
    body('allow_reactions').optional().isBoolean(),
    body('allow_color_labels').optional().isBoolean(),
    body('keybind_mode').optional().isIn(KEYBIND_MODES),
    body('css_template_id').optional({ nullable: true, checkFalsy: true }).isInt(),
    // Hero logo settings
    body('hero_logo_visible').optional({ nullable: true }).isBoolean(),
    body('hero_logo_size').optional({ nullable: true }).isIn(['small', 'medium', 'large', 'xlarge']),
    body('hero_logo_position').optional().isIn(['top', 'center', 'bottom']),
    // Header style settings (decoupled from layout)
    body('header_style').optional().isIn(['hero', 'standard', 'banner', 'minimal', 'none']),
    body('hero_divider_style').optional().isIn(['wave', 'straight', 'angle', 'curve', 'none']),
    // Hero image anchor position (#162) – accepts legacy keywords or "X% Y%" focal point
    body('hero_image_anchor').optional().custom(validateHeroImageAnchor),
    // Client access settings (#172)
    body('client_access_enabled').optional().isBoolean(),
    body('client_password').optional().custom(validateClientPassword),
    body('default_photo_sort').optional().isIn([
      'upload_date_desc', 'upload_date_asc',
      'capture_date_desc', 'capture_date_asc',
      'filename_asc', 'filename_desc'
    ]),
    // Per-event promotional override (#440). Three-way mode:
    //   inherit → fall back to global branding_promo_markdown
    //   custom  → render this event's promo_markdown verbatim
    //   off     → suppress entirely for this event
    body('promo_mode').optional().isIn(['inherit', 'custom', 'off']),
    body('promo_markdown').optional({ nullable: true }).isString(),
    // Per-event info-banner override (#932). Same three-way mode as promo,
    // but resolved against branding_info_markdown and rendered above the grid.
    body('info_mode').optional().isIn(['inherit', 'custom', 'off']),
    body('info_markdown').optional({ nullable: true }).isString(),
    // Per-event opt-in for using hero photo as the social-share preview
    // image (#474). When false (default), galleryOgService falls back to
    // the brand logo for og:image / Twitter Card.
    body('og_image_share_enabled').optional().isBoolean(),
    // Customer accounts assigned to this event (#354). Optional array of
    // customer_accounts.id — many-to-many via event_customer_assignments.
    body('customer_account_ids').optional().isArray(),
    body('customer_account_ids.*').optional().isInt({ min: 1 })
  ], async (req, res) => {
    try {
      // Redact credentials — the body carries the gallery password (GHSA-r794).
      logger.debug('Create event request body', { body: sanitizeForLog(req.body) });
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        // errors.array() embeds the SUBMITTED value per field — including a
        // rejected plaintext password (GHSA-r794).
        logger.error('Validation errors:', sanitizeValidationErrors(errors.array()));
        return res.status(400).json({ errors: safeValidationErrors(errors) });
      }

      const created = await require('../../services/eventCreationService').createEvent(req.body, {
        actor: req.admin,
        frontendUrl: await getAbsoluteFrontendUrl(req, { override: process.env.APP_URL }),
      });
      res.json(created);
    } catch (error) {
      if (error.isOperational) return res.status(error.statusCode).json(error.responseBody || { error: error.message, code: error.code });
      if (isDuplicateSlugError(error)) {
        logger.warn('Event creation lost the slug race', { error: error.message });
        return res.status(409).json(DUPLICATE_SLUG_RESPONSE);
      }
      errorResponse(res, error, 500, 'Failed to create event');
    }
  });

  // Get all events with pagination and filters
  router.get('/', adminAuth, requirePermission('events.view'), async (req, res) => {
    try {
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 20;
      const offset = (page - 1) * limit;
      const search = req.query.search || '';
      const status = req.query.status || 'all';
      const allowedSortBy = ['created_at', 'event_name', 'slug', 'updated_at', 'expires_at', 'capture_date'];
      const sortBy = allowedSortBy.includes(req.query.sortBy) ? req.query.sortBy : 'created_at';
      const sortOrder = ['asc', 'desc'].includes(req.query.sortOrder) ? req.query.sortOrder : 'desc';

      // Build query
      let query = db('events');

      // Roles other than super_admin and admin see their own events plus
      // ownerless ones, the rule requireEventOwnership applies per event.
      query = scopeEventsListQuery(query, req.admin);

      // Apply search filter
      if (search) {
        const pattern = `%${escapeLikePattern(search)}%`;
        query = query.where((builder) => {
          builder.whereRaw(likeWithEscape('event_name'), [pattern])
            .orWhereRaw(likeWithEscape('admin_email'), [pattern])
            .orWhereRaw(likeWithEscape('customer_email'), [pattern])
            .orWhereRaw(likeWithEscape('slug'), [pattern]);
        });
      }

      // Apply status filter
      if (status === 'active') {
        query = query.where('is_active', formatBoolean(true)).where('is_archived', formatBoolean(false));
      } else if (status === 'archived') {
        query = query.where('is_archived', formatBoolean(true));
      } else if (status === 'inactive') {
        query = query.where('is_active', formatBoolean(false)).where('is_archived', formatBoolean(false));
      } else if (status === 'draft') {
        query = query.where('is_draft', formatBoolean(true));
      } else if (status === 'expiring') {
        const sevenDaysFromNow = new Date();
        sevenDaysFromNow.setDate(sevenDaysFromNow.getDate() + 7);
        query = query
          .where('is_active', formatBoolean(true))
          .where('is_archived', formatBoolean(false))
          .where('expires_at', '<=', sevenDaysFromNow.toISOString())
          .where('expires_at', '>', new Date().toISOString());
      }

      // Get total count for pagination
      const countQuery = query.clone();
      const [{ count }] = await countQuery.count('* as count');

      // Apply sorting and pagination
      const events = await query
        .orderBy(sortBy, sortOrder)
        .limit(limit)
        .offset(offset);

      // Get photo counts for each event
      const eventIds = events.map(e => e.id);
      const photoCounts = await db('photos')
        .whereIn('event_id', eventIds)
        .groupBy('event_id')
        .select('event_id')
        .count('* as count');

      // Map photo counts to events
      const photoCountMap = photoCounts.reduce((acc, { event_id, count }) => {
        acc[event_id] = parseInt(count);
        return acc;
      }, {});

      // Add photo counts to events and convert dates
      const eventsWithCounts = events.map(event => ({
        ...event,
        photo_count: photoCountMap[event.id] || 0,
        // Convert Unix timestamps to ISO strings
        created_at: event.created_at ? new Date(event.created_at).toISOString() : null,
        expires_at: event.expires_at ? new Date(event.expires_at).toISOString() : null,
        archived_at: event.archived_at ? new Date(event.archived_at).toISOString() : null
      })).map((event) => withoutForeignEventSecrets(mapEventForApi(event), req.admin));

      res.json({
        events: eventsWithCounts,
        pagination: {
          page,
          limit,
          total: parseInt(count),
          totalPages: Math.ceil(count / limit)
        }
      });
    } catch (error) {
      errorResponse(res, error, 500, 'Failed to fetch events');
    }
  });

  // Get single event details
  router.get('/:id', adminAuth, requirePermission('events.view'), async (req, res) => {
    try {
      const { id } = req.params;

      // Same visibility as the list: a role limited to its own events gets a
      // 404 for anyone else's, not a 403 that confirms the event exists.
      const event = await scopeEventsListQuery(db('events').where('id', id), req.admin).first();

      if (!event) {
        return res.status(404).json({ error: 'Event not found' });
      }

      // Get photo count
      const [{ count: photoCount }] = await db('photos')
        .where('event_id', id)
        .count('* as count');

      // Get total size
      const [{ totalSize }] = await db('photos')
        .where('event_id', id)
        .sum('size_bytes as totalSize');

      // Get recent photos
      const recentPhotos = await db('photos')
        .where('event_id', id)
        .orderBy('uploaded_at', 'desc')
        .limit(10)
        .select('filename', 'type', 'size_bytes', 'uploaded_at');

      // Get view and download statistics
      const [{ totalViews }] = await db('access_logs')
        .where('event_id', id)
        .where('action', 'view')
        .count('* as totalViews');

      // One row per download event: singles AND zips (#895). Must stay in
      // sync with adminDashboard's definition or the two surfaces disagree.
      const [{ totalDownloads }] = await db('access_logs')
        .where('event_id', id)
        .whereIn('action', ['download', 'download_all', 'download_all_presigned', 'download_selected'])
        .count('* as totalDownloads');

      const [{ uniqueVisitors }] = await db('access_logs')
        .where('event_id', id)
        .countDistinct('ip_address as uniqueVisitors');

      // Customer accounts assigned to this event (#354). Hydrates the
      // CustomerAccountPicker on the EventDetailsPage admin form. Returns
      // an empty array on installs missing the table (e.g. pre-migrate).
      let customerAccounts = [];
      try {
        const customerAccountsService = require('../../services/customerAccountsService');
        customerAccounts = await customerAccountsService.getAssignmentsForEvent(parseInt(id, 10));
      } catch (e) {
        logger.warn('Failed to load customer assignments for event', { eventId: id, error: e.message });
      }
      // Their customer groups (#1443) — only for an admin who may read
      // customers; this route is guarded by events.view alone. Decoration:
      // a failure here leaves the groups out rather than failing the page.
      let groupsByCustomer = null;
      try {
        if (customerAccounts.length > 0 && await userHasAnyPermission(req.admin.id, ['customers.view'])) {
          groupsByCustomer = await require('../../services/customerGroupsService')
            .groupsForCustomers(customerAccounts.map((c) => c.id));
        }
      } catch (e) {
        logger.warn('Failed to load customer groups for event', { eventId: id, error: e.message });
      }

      res.json(withoutForeignEventSecrets(mapEventForApi({
        ...event,
        photo_count: parseInt(photoCount) || 0,
        total_size: parseInt(totalSize) || 0,
        total_views: parseInt(totalViews) || 0,
        total_downloads: parseInt(totalDownloads) || 0,
        unique_visitors: parseInt(uniqueVisitors) || 0,
        recent_photos: recentPhotos,
        customer_accounts: customerAccounts.map((c) => ({
          id: c.id,
          email: c.email,
          display_name: c.display_name,
          first_name: c.first_name,
          last_name: c.last_name,
          // The send-gallery-email fallback below filters on these, so the UI
          // needs them to predict whether the action has any recipient at all.
          // Without them every assigned account looked reachable and a gallery
          // whose only assignments were deactivated or passive offered a
          // button that then 400'd — or worse, reported success.
          is_active: c.is_active,
          can_sign_in: c.can_sign_in,
          ...(groupsByCustomer ? { groups: groupsByCustomer.get(Number(c.id)) || [] } : {}),
        })),
      }), req.admin));
    } catch (error) {
      errorResponse(res, error, 500, 'Failed to fetch event details');
    }
  });

  // Send the gallery email for an ALREADY published event (#1235).
  //
  // The other half of publish-quietly, and the half that makes it a workflow
  // rather than a dead end: the case this exists for is "no address yet, I'll
  // send the link by DM and mail it properly once they give me one". Without
  // this the operator publishes quietly and then has no way to send the real
  // email at all.
  //
  // Deliberately NOT restricted to galleries that were published quietly.
  // Re-sending is a normal thing to want — the customer deleted it, it went to
  // spam, the address was wrong and has been corrected — and refusing would
  // just push people to unpublish and republish, which changes gallery state
  // to work around a mail problem.
  router.post('/:id/send-gallery-email', adminAuth, requirePermission('events.edit'), requireEventOwnership, [
    body('password').optional().isString().isLength({ min: 6 })
      .withMessage('Password must be at least 6 characters long'),
  ], async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: safeValidationErrors(errors) });
      }

      const { id } = req.params;
      const { password } = req.body;
      const event = await db('events').where('id', id).first();

      if (!event) {
        return res.status(404).json({ error: 'Event not found' });
      }
      if (parseBooleanInput(event.is_draft, false)) {
        // A draft has no working gallery link yet, so the email would carry a
        // URL the customer cannot open. Publishing is the action they want.
        return res.status(400).json({ error: 'Event is still a draft — publish it first' });
      }
      // Same reason, for the other three ways a gallery stops being reachable:
      // the link in the email would be rejected by the gallery middleware, so
      // sending it is worse than refusing — the customer gets a dead link with
      // no explanation.
      if (parseBooleanInput(event.is_archived, false)) {
        return res.status(400).json({ error: 'Event is archived — restore it before sending' });
      }
      if (!parseBooleanInput(event.is_active, true)) {
        return res.status(400).json({ error: 'Event is inactive — the gallery link would not work' });
      }
      if (event.expires_at && new Date(event.expires_at) <= new Date()) {
        return res.status(400).json({ error: 'Event has expired — extend it before sending' });
      }

      const requirePassword = parseBooleanInput(event.require_password, true);
      const hasInlineRecipient = !!(event.customer_email || event.host_email);

      // Persist the password ONLY when the mail that carries it is actually
      // going out (#627). The account-only fallback below sends
      // customer_gallery_assigned, which links to the customer portal and
      // never mentions a password — rehashing for that would silently change
      // the live gallery password and lock out everyone holding the old one,
      // in exchange for nothing.
      if (hasInlineRecipient && requirePassword && password) {
        const policyError = await checkGalleryPasswordPolicy(password, event.event_name);
        if (policyError) return res.status(400).json(policyError);

        // Re-entering the current password is not a change: keep the hash and
        // the sessions opened with it. A new password ends those sessions.
        const copyColumns = await galleryPasswordColumns({ password });
        // Kept only while the stored hash is still the one compared: a reset
        // landing in between must not leave this request's copy (and email)
        // disagreeing with the hash. Otherwise it is written as a change.
        const keptHash = await sameAsStored(password, event.password_hash)
          && await db('events').where({ id, password_hash: event.password_hash })
            .update(Object.keys(copyColumns).length ? copyColumns : { updated_at: new Date().toISOString() });
        if (!keptHash) {
          await db('events').where('id', id).update({
            password_hash: await bcrypt.hash(password, getBcryptRounds()),
            ...(await credentialChangeColumns('gallery')),
            ...copyColumns,
          });
        }
        await dropCopiesIfStorageOff(id);
      }

      const queued = hasInlineRecipient
        && await queueGalleryCreatedEmail(event, { password, requirePassword });
      if (!queued) {
        // No inline recipient, but the gallery may be assigned to registered
        // customer account(s) — the same path publish takes. Without this the
        // publish dialog's promise that the notice can be sent later is false
        // for exactly those galleries.
        let notified = 0;
        try {
          const customerAccountsService = require('../../services/customerAccountsService');
          const assigned = await customerAccountsService.getAssignmentsForEvent(parseInt(id, 10));
          for (const c of assigned.filter(canReceiveGalleryNotice)) {
            await customerAccountsService
              .notifyCustomerOfNewAssignments(c.id, [parseInt(id, 10)])
              .then(() => { notified += 1; })
              .catch((err) => logger.warn('Send gallery email: customer notice failed', { customerId: c.id, error: err.message }));
          }
        } catch (err) {
          logger.warn('Send gallery email: assigned-customer lookup failed', { eventId: id, error: err.message });
        }
        if (notified > 0) {
          await logActivity('gallery_email_sent',
            { event_name: event.event_name, assigned_accounts: notified },
            id,
            { type: 'admin', id: req.admin.id, name: req.admin.username }
          );
          return res.json({
            message: 'Gallery notice queued',
            recipient: `${notified} assigned customer account(s)`,
          });
        }
        return res.status(400).json({
          error: 'No customer email is set for this event',
        });
      }

      await logActivity('gallery_email_sent',
        { event_name: event.event_name },
        id,
        { type: 'admin', id: req.admin.id, name: req.admin.username }
      );

      res.json({
        message: 'Gallery email queued',
        recipient: event.customer_email || event.host_email,
      });
    } catch (error) {
      errorResponse(res, error, 500, 'Failed to send the gallery email');
    }
  });

  // Publish a draft event (set is_draft=false and queue creation email)
  router.post('/:id/publish', adminAuth, requirePermission('events.edit'), requireEventOwnership, [
  // Optional password the admin re-types in the publish dialog so the
  // gallery_created email can carry the actual plaintext (#627). When the
  // event is password-protected and the body carries a password, picpeak
  // re-hashes + writes `password_hash` (the admin may have mistyped at
  // creation; this guarantees the email content matches the live login
  // password). When omitted, behaviour is the legacy sentinel for backward
  // compat with API-only consumers.
    body('password').optional().isString().isLength({ min: 6 })
      .withMessage('Password must be at least 6 characters long'),
    // Publish without telling the customer yet (#1235). Defaults to true, so
    // every existing caller — the API, older frontends — keeps notifying.
    body('notify_customer').optional().isBoolean(),
  ], async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: safeValidationErrors(errors) });
      }

      const { id } = req.params;
      const { password } = req.body;
      const notifyCustomer = parseBooleanInput(req.body?.notify_customer, true);
      const event = await db('events').where('id', id).first();

      if (!event) {
        return res.status(404).json({ error: 'Event not found' });
      }

      if (!parseBooleanInput(event.is_draft, false)) {
        return res.status(400).json({ error: 'Event is already published' });
      }

      const requirePassword = parseBooleanInput(event.require_password, true);
      const publishUpdates = { is_draft: formatBoolean(false) };
      let publishKeepsHash = false;
      let publishWritesPassword = false;
      if (requirePassword && password) {
      // Re-hash so the stored hash matches what the email carries — even if
      // the admin mistypes vs. what was set at draft creation, the gallery
      // password the customer receives is the one that actually works.
        const policyError = await checkGalleryPasswordPolicy(password, event.event_name);
        if (policyError) return res.status(400).json(policyError);

        Object.assign(publishUpdates, await galleryPasswordColumns({ password }));
        publishKeepsHash = await sameAsStored(password, event.password_hash);
        publishWritesPassword = true;
      }
      // An unchanged password keeps the hash only while it is still the one
      // compared; a password change landing in between makes this a change.
      const published = publishKeepsHash
        ? await db('events').where({ id, password_hash: event.password_hash }).update(publishUpdates)
        : 0;
      if (!published) {
        if (publishWritesPassword) {
          publishUpdates.password_hash = await bcrypt.hash(password, getBcryptRounds());
          Object.assign(publishUpdates, await credentialChangeColumns('gallery'));
        }
        await db('events').where('id', id).update(publishUpdates);
      }
      // Whenever a recoverable copy was written, not only when the hash changed.
      if (publishWritesPassword) await dropCopiesIfStorageOff(id);

      // Notify the customer — unless the admin asked to publish quietly
      // (#1235). Everything else about publishing still happens: the gallery
      // goes live, the activity is logged, and the event.published webhook
      // fires, because those describe a state change rather than a message to
      // a customer.
      const customerEmail = event.customer_email || event.host_email;
      if (notifyCustomer) {
        if (customerEmail) {
          await queueGalleryCreatedEmail(event, { password, requirePassword });
        } else {
        // No inline email, but the gallery may be assigned to registered
        // customer account(s). Notify them via the account "your galleries"
        // email (customer_gallery_assigned, in the customer's own language)
        // instead of the gallery_created mail, which needs an inline
        // recipient. Best-effort.
          try {
            const customerAccountsService = require('../../services/customerAccountsService');
            const assigned = await customerAccountsService.getAssignmentsForEvent(parseInt(id, 10));
            for (const c of assigned.filter(canReceiveGalleryNotice)) {
              await customerAccountsService
                .notifyCustomerOfNewAssignments(c.id, [parseInt(id, 10)])
                .catch((err) => logger.warn('Publish: customer gallery notice failed', { customerId: c.id, error: err.message }));
            }
          } catch (err) {
            logger.warn('Publish: assigned-customer notification skipped', { eventId: id, error: err.message });
          }
        }
      }

      // WhatsApp gallery_ready on publish-from-draft (#640D). The PublishGallery
      // dialog (#627) hands us the password back so we can deliver it via
      // WhatsApp as well. Uses customer_phone from the persisted event row.
      if (notifyCustomer && event.customer_phone) {
        try {
          const { queueWhatsapp, getWhatsAppConfig } = require('../../services/whatsappProcessor');
          const waConfig = await getWhatsAppConfig();
          if (waConfig && waConfig.enabled) {
            const { shareUrl: shareUrlForWa } = await buildShareLinkVariants({
              slug: event.slug, shareToken: event.share_token,
            });
            await queueWhatsapp(parseInt(id, 10), event.customer_phone, 'gallery_created', {
              customer_name: event.customer_name || event.host_name || '',
              event_name: event.event_name,
              gallery_link: shareUrlForWa || `${await getFrontendBaseUrl()}/gallery/${event.slug}`,
              // Plaintext only when the admin re-typed at publish; otherwise
              // omit so the buildComponents() helper renders an empty {{4}}
              // line instead of leaking the "(set at creation)" sentinel.
              gallery_password: requirePassword && password ? password : '',
              expiry_date: event.expires_at ? new Date(event.expires_at).toISOString() : null,
              language: null, // resolved by processor via general_default_language
            });
          }
        } catch (waError) {
          logger.warn('Failed to queue WhatsApp notification on publish', { error: waError.message });
        }
      }

      await logActivity('event_published',
        { event_name: event.event_name, notified_customer: notifyCustomer },
        id,
        { type: 'admin', id: req.admin.id, name: req.admin.username }
      );

      // Fire event.published webhook (#327) — draft → live transition.
      // Canonical payload (#341): includes customer contact + share_token.
      try {
        const webhookService = require('../../services/webhookService');
        const { shareUrl } = await buildShareLinkVariants({ slug: event.slug, shareToken: event.share_token });
        await webhookService.fire('event.published', {
          event: webhookService.buildEventSubject({
            id: parseInt(id, 10),
            slug: event.slug,
            event_name: event.event_name,
            event_type: event.event_type,
            event_date: event.event_date,
            share_url: shareUrl,
            share_token: event.share_token,
            customer_name: event.customer_name || event.host_name,
            customer_email: event.customer_email || event.host_email,
            customer_phone: event.customer_phone,
          }),
        });
      } catch (e) { /* non-fatal */ }

      res.json({
        message: 'Event published successfully',
        is_draft: false,
        notified_customer: notifyCustomer,
      });
    } catch (error) {
      errorResponse(res, error, 500, 'Failed to publish event');
    }
  });

  // Duplicate an event (#626). Creates a new DRAFT gallery that inherits the
  // source event's branding, behaviour, hero/header, feedback, and category
  // configuration — admin then fills in customer + publishes via the publish
  // dialog (#627), where the password is set. Photos, hero photo selection,
  // client-access secrets, customer assignments, archive/sent state are NOT
  // carried over.
  router.post('/:id/duplicate', adminAuth, requirePermission('events.create'), requireEventOwnership, [
    body('event_name').trim().notEmpty().withMessage('Event name is required'),
    body('event_date').optional({ values: 'falsy' }).isDate(),
    body('customer_name').optional().trim(),
    body('customer_email').optional({ values: 'falsy' }).isEmail().normalizeEmail(IDENTITY_PRESERVING_NORMALIZE_EMAIL),
  ], async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: safeValidationErrors(errors) });
      }

      const { id } = req.params;
      const source = await db('events').where('id', id).first();
      if (!source) {
        return res.status(404).json({ error: 'Source event not found' });
      }

      const { event_name, event_date, customer_name, customer_email } = req.body;

      // Generate a fresh unique slug using the same shape as the create path.
      const slugify = require('../../utils/slug').slugify;
      const processedEventName = slugify(event_name);
      const slugSuffix = event_date || crypto.randomBytes(3).toString('hex');
      const baseSlug = `${source.event_type}-${processedEventName}-${slugSuffix}`;
      let slug = baseSlug;
      let counter = 1;
      // eslint-disable-next-line no-await-in-loop
      while (await db('events').where({ slug }).first()) {
        slug = `${baseSlug}-${counter}`;
        counter += 1;
      }

      // Recompute expires_at: preserve the source's expiration window (delta
      // between source.expires_at and source.event_date) so the duplicate keeps
      // the same "active for N days" feel. Falls back to 30 days if source had
      // no expiration set.
      let newExpiresAt = null;
      if (event_date) {
        let expirationDays = 30;
        if (source.expires_at && source.event_date) {
          const days = Math.round(
            (new Date(source.expires_at).getTime() - new Date(source.event_date).getTime())
          / (24 * 60 * 60 * 1000),
          );
          if (days > 0) expirationDays = days;
        }
        const [year, month, day] = event_date.split('-').map((s) => parseInt(s, 10));
        const baseDate = new Date(year, month - 1, day);
        baseDate.setDate(baseDate.getDate() + expirationDays);
        newExpiresAt = baseDate;
      }

      const shareToken = crypto.randomBytes(16).toString('hex');
      const { shareLinkToStore } = await buildShareLinkVariants({ slug, shareToken });

      // Random-placeholder password hash. When the admin publishes via the
      // PublishGalleryDialog (#627), the dialog re-hashes whatever they type and
      // overwrites this. Pattern matches the create path at line ~606.
      const password_hash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), getBcryptRounds());

      // Create the storage folder structure (same as create path).
      const storagePath = process.env.STORAGE_PATH || path.join(__dirname, '../../../../storage');
      const eventPath = path.join(storagePath, 'events/active', slug);
      await fs.mkdir(path.join(eventPath, 'collages'), { recursive: true });
      await fs.mkdir(path.join(eventPath, 'individual'), { recursive: true });

      const customerColumnsAvailable = await hasCustomerContactColumns();
      const calendarColumnsExist = await hasColumnCached('events', 'is_full_day');

      // Build the insert row. Copy behaviour + branding fields from source;
      // leave per-gallery secrets / state / photos blank.
      const insertResult = await db('events').insert({
        slug,
        event_type: source.event_type,
        event_name,
        event_date: event_date || null,
        ...(calendarColumnsExist ? {
          event_time_start: source.event_time_start,
          event_time_end: source.event_time_end,
          is_full_day: source.is_full_day,
        } : {}),
        ...(customerColumnsAvailable ? {
          customer_name: customer_name || null,
          customer_email: customer_email || null,
        } : {}),
        host_name: customer_name || null,
        host_email: customer_email || null,
        admin_email: source.admin_email || null,
        password_hash,
        welcome_message: source.welcome_message || '',
        color_theme: source.color_theme,
        share_link: shareLinkToStore,
        share_token: shareToken,
        expires_at: newExpiresAt ? newExpiresAt.toISOString() : null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        created_by: req.admin.id,
        allow_user_uploads: source.allow_user_uploads,
        upload_category_id: source.upload_category_id,
        // Uploader names are part of the gallery's configuration (#1561).
        guest_name_mode: source.guest_name_mode || 'off',
        show_credits_to_guests: formatBoolean(parseBooleanInput(source.show_credits_to_guests, false)),
        allow_downloads: source.allow_downloads,
        disable_right_click: source.disable_right_click,
        enable_devtools_protection: source.enable_devtools_protection,
        // A duplicate inherits the source's protection settings, NOT the
        // current global defaults — copying the gallery is the whole point.
        // These four sat next to enable_devtools_protection and were simply
        // missed, so duplicating a 'maximum' event produced a 'standard' one
        // (#1296).
        protection_level: source.protection_level,
        image_quality: source.image_quality,
        use_canvas_rendering: source.use_canvas_rendering,
        watermark_downloads: source.watermark_downloads,
        watermark_text: source.watermark_text,
        require_password: source.require_password,
        css_template_id: source.css_template_id || null,
        hero_logo_visible: source.hero_logo_visible,
        hero_logo_size: source.hero_logo_size,
        hero_logo_position: source.hero_logo_position,
        // Banner overrides travel with the copy: the duplicate dialog promises
        // the new gallery 'inherits the branding, behaviour, feedback, and
        // category configuration', and a gallery muted with 'off' silently
        // un-muting on duplication is the opposite of that.
        // Markdown rides along only while the mode is 'custom': rows written
        // before the PUT normalisation landed can hold stale text on an
        // 'inherit'/'off' gallery, and copying it would resurrect that text
        // the moment someone switched the duplicate to 'custom'.
        promo_mode: source.promo_mode || 'inherit',
        promo_markdown: source.promo_mode === 'custom' ? (source.promo_markdown || null) : null,
        info_mode: source.info_mode || 'inherit',
        info_markdown: source.info_mode === 'custom' ? (source.info_markdown || null) : null,
        login_logo_visible: source.login_logo_visible,
        header_style: source.header_style || 'standard',
        hero_divider_style: source.hero_divider_style || 'wave',
        hero_image_anchor: source.hero_image_anchor || 'center',
        photo_cap: source.photo_cap || null,
        // The limit is part of the package; the grants belong to the source
        // gallery's client and stay behind (issue 1560).
        download_limit: source.download_limit || null,
        is_draft: formatBoolean(true),
        default_photo_sort: source.default_photo_sort || 'upload_date_desc',
        // Client-access secrets and the OG-share opt-in deliberately do NOT
        // carry over — admin re-decides per gallery.
        client_access_enabled: formatBoolean(false),
        og_image_share_enabled: formatBoolean(false),
      }).returning('id');

      const newEventId = insertResult[0]?.id || insertResult[0];

      // Copy event_feedback_settings if the source had a row (only present when
      // feedback_enabled was true on the source event).
      const sourceFeedback = await db('event_feedback_settings').where({ event_id: id }).first();
      if (sourceFeedback) {
        await db('event_feedback_settings').insert({
          event_id: newEventId,
          feedback_enabled: sourceFeedback.feedback_enabled,
          allow_ratings: sourceFeedback.allow_ratings,
          allow_likes: sourceFeedback.allow_likes,
          allow_comments: sourceFeedback.allow_comments,
          allow_favorites: sourceFeedback.allow_favorites,
          allow_reactions: sourceFeedback.allow_reactions,
          // A clone copies the SOURCE event, so these come from the source
          // row rather than the global defaults (#1044).
          allow_color_labels: sourceFeedback.allow_color_labels,
          keybind_mode: sourceFeedback.keybind_mode,
          require_name_email: sourceFeedback.require_name_email,
          moderate_comments: sourceFeedback.moderate_comments,
          show_feedback_to_guests: sourceFeedback.show_feedback_to_guests,
          // Including the identity mode (#1197): a clone that silently came
          // back in 'simple' would drop the shared tag on a gallery duplicated
          // precisely to reuse its proofing setup.
          identity_mode: sourceFeedback.identity_mode || 'simple',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
      }

      // Copy per-event photo categories (global categories are not duplicated —
      // they apply to every event already). Mapping by name; photo_categories
      // has no foreign key into photos here so we just clone the rows.
      if (await db.schema.hasTable('photo_categories')) {
        const sourceCategories = await db('photo_categories')
          .where({ event_id: id })
          .where(function () { this.whereNull('is_global').orWhere('is_global', formatBoolean(false)); })
          .select('name', 'slug', 'is_global', 'is_folder');
        if (sourceCategories.length > 0) {
          await db('photo_categories').insert(
            sourceCategories.map((c) => ({
              event_id: newEventId,
              name: c.name,
              slug: c.slug,
              is_global: formatBoolean(false),
              // #1160: carry folder-ness across. Without this the clone silently
              // falls back to the column default and a duplicated gallery turns
              // every folder back into a filter.
              is_folder: formatBoolean(parseBooleanInput(c.is_folder, false)),
            })),
          );
        }
      }

      await logActivity('event_duplicated',
        { source_event_id: parseInt(id, 10), source_event_name: source.event_name },
        newEventId,
        { type: 'admin', id: req.admin.id, name: req.admin.username },
      );

      res.json({
        message: 'Event duplicated successfully',
        id: newEventId,
        slug,
        is_draft: true,
      });
    } catch (error) {
      if (isDuplicateSlugError(error)) {
        logger.warn('Event duplication lost the slug race', { error: error.message });
        return res.status(409).json(DUPLICATE_SLUG_RESPONSE);
      }
      errorResponse(res, error, 500, 'Failed to duplicate event');
    }
  });

  // Update event
  router.put('/:id', adminAuth, requirePermission('events.edit'), requireEventOwnership, [
    body('event_name').optional().trim().notEmpty(),
    body('event_date').optional({ values: 'falsy' }).isDate(),
    // Migration 137 — calendar time fields. Same regex/range rule as POST.
    body('event_time_start').optional({ values: 'falsy', nullable: true })
      .matches(/^([01]\d|2[0-3]):[0-5]\d$/)
      .withMessage('event_time_start must be HH:MM 24h'),
    body('event_time_end').optional({ values: 'falsy', nullable: true })
      .matches(/^([01]\d|2[0-3]):[0-5]\d$/)
      .withMessage('event_time_end must be HH:MM 24h'),
    body('is_full_day').optional().isBoolean().toBoolean(),
    body('admin_email').optional().isEmail(),
    body('is_active').optional().isBoolean(),
    body('expires_at').optional({ nullable: true, checkFalsy: true }).isISO8601(),
    body('welcome_message').optional({ nullable: true, checkFalsy: true }).trim(),
    body('color_theme').optional({ nullable: true }),
    body('allow_user_uploads').optional().isBoolean(),
    // Uploader names (#1561).
    body('guest_name_mode').optional().isIn(GUEST_NAME_MODES),
    body('show_credits_to_guests').optional().isBoolean(),
    // Reveal mode (#838): hide the gallery from guests until reveal.
    body('reveal_mode').optional().isBoolean(),
    body('reveal_at').optional({ nullable: true, checkFalsy: true }).isISO8601(),
    // Migration 143 — per-event reminder overrides. All three are
    // optional; nullable values are accepted so admins can clear an
    // override (e.g. drop a custom offset back to the global default).
    body('event_reminder_disabled').optional().isBoolean(),
    body('event_reminder_offset_days').optional({ nullable: true })
      .custom((v) => v === null || (Number.isInteger(Number(v)) && Number(v) >= 0))
      .withMessage('event_reminder_offset_days must be a non-negative integer or null'),
    body('event_reminder_body_override').optional({ nullable: true, checkFalsy: true })
      .isString().isLength({ max: 10_000 }),
    body('customer_name').optional({ nullable: true, checkFalsy: true }).trim(),
    body('customer_email').optional().isEmail().normalizeEmail(IDENTITY_PRESERVING_NORMALIZE_EMAIL),
    body('customer_phone').optional({ nullable: true, checkFalsy: true })
      .isString().trim()
      .isLength({ max: 32 }).withMessage('Phone number must be at most 32 characters'),
    body('upload_category_id').optional().custom((value) => {
    // Accept null, undefined, or integer values
      if (value === null || value === undefined) return true;
      return Number.isInteger(Number(value));
    }).withMessage('upload_category_id must be an integer or null'),
    body('hero_photo_id').optional().custom((value) => {
    // Accept null, undefined, or numeric values
      if (value === null || value === undefined) return true;
      // Check if it's a number or can be converted to a valid integer
      const num = Number(value);
      return !isNaN(num) && Number.isInteger(num);
    }).withMessage('hero_photo_id must be an integer or null'),
    body('allow_downloads').optional().isBoolean(),
    // Download limit (issue 1560). null clears it; the column is a signed
    // 32-bit int like photo_cap.
    body('download_limit').optional({ nullable: true }).isInt({ min: 1, max: 2147483647 }).toInt(),
    body('disable_right_click').optional().isBoolean(),
    body('watermark_downloads').optional().isBoolean(),
    body('watermark_text').optional().trim(),
    body('source_mode').optional().isIn(['managed', 'reference']),
    body('external_path').optional({ nullable: true }).isString().trim(),
    body('external_watch').optional().isBoolean(),
    body('require_password').optional().isBoolean(),
    // Download protection settings
    body('protection_level').optional().isIn(['basic', 'standard', 'enhanced', 'maximum']),
    body('enable_devtools_protection').optional().isBoolean(),
    body('use_canvas_rendering').optional().isBoolean(),
    body('overlay_protection').optional().isBoolean(),
    body('image_quality').optional().isInt({ min: 1, max: 100 }),
    body('password').optional().isString().custom((value) => {
      if (value === undefined || value === null || value === '') {
        return true;
      }
      if (typeof value !== 'string' || value.trim().length < 6) {
        throw new Error('Password must be at least 6 characters long');
      }
      return true;
    }),
    body('css_template_id').optional({ nullable: true, checkFalsy: true }).isInt(),
    // Hero logo settings
    body('hero_logo_visible').optional({ nullable: true }).isBoolean(),
    body('hero_logo_size').optional({ nullable: true }).isIn(['small', 'medium', 'large', 'xlarge']),
    body('hero_logo_position').optional().isIn(['top', 'center', 'bottom']),
    // Password-page logo toggle (#894). null = default (show).
    body('login_logo_visible').optional({ nullable: true }).isBoolean(),
    // Header style settings (decoupled from layout)
    body('header_style').optional().isIn(['hero', 'standard', 'banner', 'minimal', 'none']),
    body('hero_divider_style').optional().isIn(['wave', 'straight', 'angle', 'curve', 'none']),
    // Hero image anchor position (#162) – accepts legacy keywords or "X% Y%" focal point
    body('hero_image_anchor').optional().custom(validateHeroImageAnchor),
    // Client access settings (#172)
    body('client_access_enabled').optional().isBoolean(),
    body('client_password').optional().custom(validateClientPassword),
    body('regenerate_client_token').optional().isBoolean(),
    body('default_photo_sort').optional().isIn([
      'upload_date_desc', 'upload_date_asc',
      'capture_date_desc', 'capture_date_asc',
      'filename_asc', 'filename_desc'
    ]),
    // Per-event promotional override (#440). Three-way mode:
    //   inherit → fall back to global branding_promo_markdown
    //   custom  → render this event's promo_markdown verbatim
    //   off     → suppress entirely for this event
    body('promo_mode').optional().isIn(['inherit', 'custom', 'off']),
    body('promo_markdown').optional({ nullable: true }).isString(),
    // Per-event info-banner override (#932). Same three-way mode as promo,
    // but resolved against branding_info_markdown and rendered above the grid.
    body('info_mode').optional().isIn(['inherit', 'custom', 'off']),
    body('info_markdown').optional({ nullable: true }).isString(),
    // Per-event opt-in for using hero photo as the social-share preview
    // image (#474). When false (default), galleryOgService falls back to
    // the brand logo for og:image / Twitter Card.
    body('og_image_share_enabled').optional().isBoolean(),
    // Customer accounts assigned to this event (#354). Optional array of
    // customer_accounts.id — many-to-many via event_customer_assignments.
    body('customer_account_ids').optional().isArray(),
    body('customer_account_ids.*').optional().isInt({ min: 1 })
  ], async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        // Redact credentials — an invalid update still logs the whole body (GHSA-pgmp).
        logger.debug('Update event validation errors', { errors: sanitizeValidationErrors(errors.array()), body: sanitizeForLog(req.body) });
        return res.status(400).json({ errors: safeValidationErrors(errors) });
      }

      const { id } = req.params;
      const updates = { ...req.body };

      // express-validator applies isInt/isIn/isBoolean element-wise to
      // arrays, so `image_quality: [72]` satisfies its validator and stays
      // an array. This handler spreads req.body into .update() with no
      // column allow-list, so such a value reaches a scalar column: a PG
      // insert error, and `[false]` coerced to true by formatBoolean.
      //
      // Guarded here rather than per field because it applies to all 44
      // validated fields, not to a chosen few. `customer_account_ids` is the
      // only field that is legitimately an array, and it is deleted from
      // `updates` below before the write (#1296).
      const ARRAY_VALUED_FIELDS = new Set(['customer_account_ids']);
      const arrayValued = Object.keys(updates)
        .filter((key) => Array.isArray(updates[key]) && !ARRAY_VALUED_FIELDS.has(key));
      if (arrayValued.length > 0) {
        return res.status(400).json({
          error: `Array values are not accepted for: ${arrayValued.join(', ')}`,
        });
      }

      // Strip identity/provenance/secret columns from the mass-assigned
      // body (GHSA-3rqx). The handler spreads req.body straight into the
      // events UPDATE, so without this an events.edit holder could rewrite
      // ownership (created_by), routing identity (slug/share_link), the
      // share/client tokens, or the password hashes directly. Plaintext
      // `password`/`client_password` inputs are NOT stripped — those are the
      // supported way to change credentials and get hashed below; the
      // tokens are regenerated internally where needed.
      // The handler spreads req.body straight into the events UPDATE, so any
      // column an events.edit holder names is writable unless blocked here.
      // This is a COMPLETE deny-set of every server-managed / permission-gated
      // events column (enumerated from the schema); everything else is a
      // legitimate edit-form field and passes through, including input-only
      // keys (password/client_password) the handler transforms below. New
      // server-managed columns MUST be added here. (codex review — GHSA-3rqx.)
      const IMMUTABLE_EVENT_COLUMNS = [
        // Identity / provenance
        'id', 'created_by', 'created_at', 'updated_at', 'slug',
        // Routing + share/client tokens (generated at create / internally)
        'share_link', 'share_token', 'client_share_token', 'show_share_token',
        // Secrets (set via the plaintext password/client_password inputs)
        'password_hash', 'client_password_hash',
        // #1271 — encrypted copies follow the hashes; a forged ciphertext
        // from another owner's row would decrypt through /:id/password
        'password_recoverable', 'client_password_recoverable',
        // Server-consumed file paths — e.g. DELETE /:id/logo fs.unlink()s
        // hero_logo_path, so a forged value is an arbitrary-delete primitive.
        'hero_logo_path', 'hero_logo_url', 'archive_path', 'download_zip_path',
        // Written by archiveService from the zip's real byte count; the
        // archives list both sorts and displays it.
        'archive_size',
        // Server-managed timestamps
        'download_zip_generated_at', 'archived_at', 'revealed_at', 'event_reminder_sent_at',
        // Credential-change cutoffs: clearing one would revive the sessions
        // the password change ended.
        'gallery_password_changed_at', 'client_password_changed_at',
        // Lifecycle — governed by dedicated permission-gated routes
        // (events.archive/restore, publish, activate/deactivate), not events.edit.
        'is_archived', 'is_draft', 'is_active',
        // Relationships — managed by projectService.assignEvent + its
        // customer-consistency checks, and events.edit ≠ quotes/contracts perms.
        'project_id', 'quote_id',
        // Legacy mirrors — rejected explicitly below in favour of customer_*.
        'host_name', 'host_email',
      ];
      // Only canonical keys reach the UPDATE. SQLite resolves quoted
      // identifiers case-insensitively, so `{ "Event_Name": ... }` lands on
      // event_name there while every check in this handler — validators,
      // the permission guards on individual fields, the deny-set below — is
      // keyed on the exact lowercase name. Every events column and every
      // input-only key this handler accepts is lowercase snake_case, so a key
      // with any uppercase in it is not something a legitimate client sends;
      // it is dropped before anything looks at it. The deny-set keeps its own
      // case-folding as belt and braces (GHSA-3rqx).
      for (const key of Object.keys(updates)) {
        if (key !== key.toLowerCase()) delete updates[key];
      }
      const denied = new Set(IMMUTABLE_EVENT_COLUMNS.map((c) => c.toLowerCase()));
      for (const key of Object.keys(updates)) {
        if (denied.has(key.toLowerCase())) delete updates[key];
      }

      const customerColumnsAvailable = await hasCustomerContactColumns();

      if (Object.prototype.hasOwnProperty.call(updates, 'host_name') || Object.prototype.hasOwnProperty.call(updates, 'host_email')) {
        return res.status(400).json({ error: 'host_name and host_email are no longer supported. Use customer_name and customer_email instead.' });
      }

      if (Object.prototype.hasOwnProperty.call(updates, 'customer_name')) {
        const nextName = getCustomerNameFromPayload(updates);
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

      if (Object.prototype.hasOwnProperty.call(updates, 'customer_email')) {
        const nextEmail = getCustomerEmailFromPayload(updates);
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

      // Phone is gated on the global toggle (#322). Strip from the update
      // unconditionally if disabled — even null/clear is rejected so an
      // admin can't accidentally write to a field they've turned off.
      if (Object.prototype.hasOwnProperty.call(updates, 'customer_phone')) {
        const phoneEnabled = await isPhoneFieldEnabled();
        if (!phoneEnabled) {
          delete updates.customer_phone;
        } else {
          const nextPhone = getCustomerPhoneFromPayload(updates);
          updates.customer_phone = nextPhone || null;
        }
      }

      const hasRequirePasswordUpdate = Object.prototype.hasOwnProperty.call(updates, 'require_password');
      let requirePasswordUpdate;
      if (hasRequirePasswordUpdate) {
        requirePasswordUpdate = parseBooleanInput(updates.require_password, true);
        updates.require_password = formatBoolean(requirePasswordUpdate);
      }

      let newPasswordPlain;
      if (Object.prototype.hasOwnProperty.call(updates, 'password')) {
        if (updates.password === undefined || updates.password === null || updates.password === '') {
          delete updates.password;
        } else {
          newPasswordPlain = updates.password;
          delete updates.password;
        }
      }

      if (Object.prototype.hasOwnProperty.call(updates, 'source_mode')) {
        updates.source_mode = updates.source_mode === 'reference' ? 'reference' : 'managed';
      }

      if (Object.prototype.hasOwnProperty.call(updates, 'external_path')) {
        const trimmedPath = updates.external_path ? String(updates.external_path).trim() : '';
        updates.external_path = trimmedPath || null;
      }

      // The permission guard below inspects `external_watch` / `external_path`
      // by exact name, but SQLite resolves column names case-insensitively, so
      // `External_Watch` would sail past it and still land on the column.
      // Anything that is one of these two keys in any spelling other than the
      // canonical one is dropped here, before the guard.
      for (const key of Object.keys(updates)) {
        const lower = key.toLowerCase();
        if ((lower === 'external_watch' || lower === 'external_path') && key !== lower) delete updates[key];
      }

      // Folder watcher opt-in (issue 1187). Written through formatBoolean
      // like the other event flags so SQLite gets 0/1; a managed event has
      // no folder to watch, so the switch is cleared with the path.
      if (Object.prototype.hasOwnProperty.call(updates, 'external_watch')) {
        updates.external_watch = formatBoolean(updates.external_watch === true || updates.external_watch === 'true');
      }

      // Enabling the watcher, or pointing an enabled one at another folder,
      // makes the server import on this admin's behalf — which the manual
      // Import endpoint requires photos.upload for. events.edit alone must
      // not be a way around that. Only transitions are checked: a save that
      // leaves an already-watched event as it is stays an events.edit
      // operation, so a role without photos.upload can still edit the rest.
      if (Object.prototype.hasOwnProperty.call(updates, 'external_watch') || Object.prototype.hasOwnProperty.call(updates, 'external_path')) {
        const current = await db('events').where('id', id).select('external_watch', 'external_path').first();
        const wasWatched = Boolean(current?.external_watch);
        const willWatch = Object.prototype.hasOwnProperty.call(updates, 'external_watch')
          ? Boolean(updates.external_watch)
          : wasWatched;
        const pathChanges = Object.prototype.hasOwnProperty.call(updates, 'external_path')
          && (updates.external_path || null) !== (current?.external_path || null);
        if (willWatch && ((!wasWatched) || pathChanges)) {
          if (!(await userHasAllPermissions(req.admin.id, ['photos.upload']))) {
            return res.status(403).json({ error: 'The photos.upload permission is required to enable automatic imports for this folder' });
          }
        }
      }

      if (updates.source_mode === 'managed') {
        updates.external_path = null;
        updates.external_watch = formatBoolean(false);
      }

      if (updates.source_mode === 'reference' && (updates.external_path === null || updates.external_path === undefined)) {
        return res.status(400).json({ error: 'external_path is required when source_mode is reference' });
      }

      // Plaintexts to remember after the row is written (#1271); each key is
      // only set when this request changed that password.
      const recoverable = {};
      // Credentials this request changed; sessions opened with the old one end.
      const credentialChanges = new Set();
      // Hashes left alone because the submitted password matched; the write is
      // conditional on them so a concurrent change cannot slip underneath.
      let keptGalleryHash = false;
      let keptClientHash = false;
      if (Object.prototype.hasOwnProperty.call(updates, 'client_password') && updates.client_password) {
        updates.client_password_hash = await bcrypt.hash(updates.client_password, getBcryptRounds());
        recoverable.clientPassword = updates.client_password;
        delete updates.client_password;
      } else {
        delete updates.client_password;
      }
      if (updates.regenerate_client_token) {
        updates.client_share_token = crypto.randomBytes(32).toString('hex');
        credentialChanges.add('client');
      }
      delete updates.regenerate_client_token;

      // customer_account_ids (#354) is a body-only field consumed
      // separately below by customerAccountsService.setAssignmentsForEvent
      // — it isn't a column on the events table, so spreading it into
      // the UPDATE statement throws "column does not exist" and crashes
      // the entire edit with 500 Failed to update event.
      delete updates.customer_account_ids;

      // Migration 137 — calendar time triple. Renormalise only when at
      // least one of the three fields was supplied; otherwise leave the
      // row's current values alone. is_full_day=true forces both times
      // to null. Drop the fields silently on un-migrated installs.
      const timeFieldsTouched = (
        Object.prototype.hasOwnProperty.call(updates, 'event_time_start')
      || Object.prototype.hasOwnProperty.call(updates, 'event_time_end')
      || Object.prototype.hasOwnProperty.call(updates, 'is_full_day')
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
          delete updates.event_time_start;
          delete updates.event_time_end;
          delete updates.is_full_day;
        }
      }

      // Log the update request for debugging
      // `updates` no longer holds the plaintext password (stripped above), but
      // it still carries client_password_hash and — when regenerate_client_token
      // was passed — a LIVE client_share_token bearer credential.
      logger.debug('Update event request', {
        id,
        updates: sanitizeForLog(updates),
        color_theme_length: updates.color_theme ? updates.color_theme.length : 0,
        color_theme_type: typeof updates.color_theme,
        hero_photo_id: updates.hero_photo_id,
        hero_photo_id_type: typeof updates.hero_photo_id
      });

      // Check if event exists
      // Ownership: the rule requireEventOwnership already enforced, kept as
      // defence in depth (issue 1670, §2.4).
      const event = await scopeEventsQuery(db('events').where('id', id), req.admin).first();
      if (!event) {
        return res.status(404).json({ error: 'Event not found' });
      }

      const currentRequirePassword = parseBooleanInput(event.require_password, true);

      // Resubmitting the current client password is not a change: keep the hash
      // and the client sessions opened with it.
      if (updates.client_password_hash) {
        if (await sameAsStored(recoverable.clientPassword, event.client_password_hash)) {
          delete updates.client_password_hash;
          keptClientHash = true;
        } else {
          credentialChanges.add('client');
        }
      }

      if (hasRequirePasswordUpdate && requirePasswordUpdate === true && !currentRequirePassword && !newPasswordPlain) {
        return res.status(400).json({ error: 'Password must be provided when enabling password requirement.' });
      }

      if (newPasswordPlain) {
        recoverable.password = newPasswordPlain;
        if (!(await sameAsStored(newPasswordPlain, event.password_hash))) {
          updates.password_hash = await bcrypt.hash(newPasswordPlain, getBcryptRounds());
          credentialChanges.add('gallery');
        } else {
          keptGalleryHash = true;
        }
      } else if (hasRequirePasswordUpdate && requirePasswordUpdate === false && currentRequirePassword) {
        updates.password_hash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), getBcryptRounds());
        recoverable.password = null;
      }

      // Enforce expires_at requirement based on app settings
      // Allow admins to clear `expires_at` on edit even when the global
      // `event_require_expiration` setting is ON (#426). The setting now
      // controls only the create-time default — once an event exists, an
      // admin editing it can override and remove the expiration. Empty /
      // null values normalize to NULL in the column ("never expires").
      if (Object.prototype.hasOwnProperty.call(updates, 'expires_at') && !updates.expires_at) {
        updates.expires_at = null;
      }

      // Format hero logo settings if provided. null = inherit the global
      // branding_logo_display_hero toggle (#756); only an explicit true/false
      // is a per-event override.
      if (Object.prototype.hasOwnProperty.call(updates, 'hero_logo_visible')) {
        updates.hero_logo_visible = updates.hero_logo_visible === null
          ? null
          : formatBoolean(updates.hero_logo_visible);
      }

      // Password-page logo toggle (#894): null passes through; other
      // accepted representations ("false", 0, …) are parsed before the
      // DB formatting — formatBoolean alone would store the truthy
      // string "false" as 1.
      if (Object.prototype.hasOwnProperty.call(updates, 'login_logo_visible')) {
        updates.login_logo_visible = updates.login_logo_visible === null
          ? null
          : formatBoolean(parseBooleanInput(updates.login_logo_visible, true));
      }

      // Per-event opt-in for hero-photo OG share image (#474). Coerce so
      // SQLite stores 0/1 and Postgres stores boolean true/false.
      if (Object.prototype.hasOwnProperty.call(updates, 'og_image_share_enabled')) {
        updates.og_image_share_enabled = formatBoolean(updates.og_image_share_enabled === true);
      }

      // Per-event promotional override (#440). Normalize promo_markdown to
      // NULL when mode is anything other than 'custom' so we don't carry
      // stale text after the admin switches modes. Empty markdown also
      // becomes NULL.
      // Banner overrides (#440 promo / #932 info). Markdown is stored ONLY
      // while the mode is 'custom', so switching modes can't leave stale copy
      // that reappears later.
      //
      // The mode must be resolved against the STORED row when a partial PUT
      // sends only the markdown: reading updates.promo_mode alone leaves it
      // undefined, which used to fall through to the "store it" branch and
      // park hidden text on an 'inherit'/'off' gallery — text that then
      // resurfaced the moment someone switched that gallery to 'custom'.
      let storedBannerModes = null;
      for (const field of ['promo', 'info']) {
        const modeKey = `${field}_mode`;
        const mdKey = `${field}_markdown`;
        if (!Object.prototype.hasOwnProperty.call(updates, modeKey)
        && !Object.prototype.hasOwnProperty.call(updates, mdKey)) continue;

        let effectiveMode = updates[modeKey];
        if (!Object.prototype.hasOwnProperty.call(updates, modeKey)) {
          // Partial PUT that sent only the markdown — read the stored mode.
          // Fetched at most once per request, and only on this path.
          if (storedBannerModes === null) {
            storedBannerModes = await db('events')
              .where('id', id)
              .select('promo_mode', 'info_mode')
              .first() || {};
          }
          effectiveMode = storedBannerModes[modeKey];
        }

        if (effectiveMode !== 'custom') {
          updates[mdKey] = null;
        } else if (Object.prototype.hasOwnProperty.call(updates, mdKey)) {
          const md = typeof updates[mdKey] === 'string' ? updates[mdKey].trim() : '';
          updates[mdKey] = md || null;
        }
      }

      // Sync header_style / hero_divider_style from color_theme JSON when not
      // explicitly provided in the request body (#158).  This ensures the
      // database columns stay in sync even if the frontend only sends the
      // serialised theme object.
      if (updates.color_theme && !Object.prototype.hasOwnProperty.call(updates, 'header_style')) {
        try {
          const themeStr = typeof updates.color_theme === 'string' ? updates.color_theme : '';
          if (themeStr.startsWith('{')) {
            const parsed = JSON.parse(themeStr);
            if (parsed.headerStyle) {
              updates.header_style = parsed.headerStyle;
            }
            if (parsed.heroDividerStyle && !Object.prototype.hasOwnProperty.call(updates, 'hero_divider_style')) {
              updates.hero_divider_style = parsed.heroDividerStyle;
            }
          }
        } catch (_) {
        // color_theme is not JSON (e.g. preset name) – nothing to extract
        }
      }

      // Written through formatBoolean like the other event flags (#1561).
      if (Object.prototype.hasOwnProperty.call(updates, 'show_credits_to_guests')) {
        updates.show_credits_to_guests = formatBoolean(parseBooleanInput(updates.show_credits_to_guests, false));
      }

      // Reveal mode (#838). Turning the toggle ON from off clears
      // revealed_at, so a gallery can be re-hidden after a reveal;
      // reveal_at accepts null/'' to drop a schedule.
      if (Object.prototype.hasOwnProperty.call(updates, 'reveal_mode')) {
        const nextRevealMode = parseBooleanInput(updates.reveal_mode, false);
        updates.reveal_mode = formatBoolean(nextRevealMode);
        const wasOn = event.reveal_mode === true || event.reveal_mode === 1 || event.reveal_mode === '1';
        if (nextRevealMode && !wasOn) {
          updates.revealed_at = null;
          // A stale PAST schedule from a previous cycle would instantly
          // re-open the gate on re-arm. Only bites partial API updates —
          // isGalleryHidden() with the stamp cleared tells us whether the
          // stored schedule still hides anything.
          const { isGalleryHidden } = require('../../utils/revealMode');
          if (!Object.prototype.hasOwnProperty.call(updates, 'reveal_at')
              && event.reveal_at
              && !isGalleryHidden({ reveal_mode: true, revealed_at: null, reveal_at: event.reveal_at })) {
            updates.reveal_at = null;
          }
        }
      }
      if (Object.prototype.hasOwnProperty.call(updates, 'reveal_at')) {
        // ISO string, not a Date object — the SQLite driver stringifies raw
        // Dates uselessly; ISO round-trips on both engines.
        updates.reveal_at = updates.reveal_at ? new Date(updates.reveal_at).toISOString() : null;
        // Scheduling a FUTURE reveal on an already-revealed gallery re-arms
        // hiding — that's the only way this state can be reached, since
        // "Reveal now" and the scheduler both clear/consume the schedule.
        if (updates.reveal_at && new Date(updates.reveal_at) > new Date() && event.revealed_at) {
          updates.revealed_at = null;
        }
      }

      // Handle client access fields (#172)
      if (Object.prototype.hasOwnProperty.call(updates, 'client_access_enabled')) {
        updates.client_access_enabled = formatBoolean(updates.client_access_enabled);
        if (!parseBooleanInput(updates.client_access_enabled, false) && parseBooleanInput(event.client_access_enabled, false)) {
          credentialChanges.add('client');
        }
        // Auto-generate client share token when first enabling
        if (parseBooleanInput(updates.client_access_enabled, false) && !event.client_share_token && !updates.client_share_token) {
          updates.client_share_token = crypto.randomBytes(32).toString('hex');
        }
      }

      // Update event. Skip the write when the denylist (or masked secrets)
      // left nothing to change — Knex rejects .update({}) with an error,
      // which would surface as a 500 for an otherwise-valid no-op request
      // (e.g. a body of only protected fields). (codex review.)
      if (Object.keys(recoverable).length > 0) Object.assign(updates, await galleryPasswordColumns(recoverable));
      if (credentialChanges.size > 0) Object.assign(updates, await credentialChangeColumns(...credentialChanges));
      if (Object.keys(updates).length > 0) {
        let eventUpdate = db('events').where('id', id);
        if (keptGalleryHash) eventUpdate = eventUpdate.where('password_hash', event.password_hash);
        if (keptClientHash) eventUpdate = eventUpdate.where('client_password_hash', event.client_password_hash);
        const updated = await eventUpdate.update(updates);
        if (!updated && (keptGalleryHash || keptClientHash)) {
          // A password changed underneath: write the submitted ones as changes.
          if (keptGalleryHash) {
            updates.password_hash = await bcrypt.hash(newPasswordPlain, getBcryptRounds());
            credentialChanges.add('gallery');
          }
          if (keptClientHash) {
            updates.client_password_hash = await bcrypt.hash(recoverable.clientPassword, getBcryptRounds());
            credentialChanges.add('client');
          }
          Object.assign(updates, await credentialChangeColumns(...credentialChanges));
          await db('events').where('id', id).update(updates);
        }
      }
      if (Object.keys(recoverable).length > 0) await dropCopiesIfStorageOff(id);

      // Customer-account assignments (#354). Same skip semantics as POST:
      // ignore when the customer portal flag is off so stale tabs don't
      // 4xx the whole edit.
      if (Array.isArray(req.body.customer_account_ids)) {
        try {
          const customerAccountsService = require('../../services/customerAccountsService');
          if (await customerAccountsService.isCustomerPortalEnabled()) {
            await customerAccountsService.setAssignmentsForEvent(
              parseInt(id, 10),
              req.body.customer_account_ids,
              req.admin.id
            );
          }
        } catch (e) {
          logger.error('Failed to set customer assignments on event update', {
            eventId: id, error: e.message,
          });
        }
      }

      // Log activity
      await logActivity('event_updated',
        { changes: Object.keys(updates), eventName: event.event_name },
        id,
        { type: 'admin', id: req.admin.id, name: req.admin.username }
      );

      // Invalidate download zip if watermark settings changed
      const changeKeys = Object.keys(req.body);
      if (changeKeys.includes('watermark_downloads') || changeKeys.includes('watermark_text')) {
        downloadZipService.invalidate(parseInt(id));
      }

      res.json({ message: 'Event updated successfully' });
    } catch (error) {
      errorResponse(res, error, 500, 'Failed to update event');
    }
  });

  // Delete event
  // Reveal now (#838): stamp revealed_at so the gallery opens for guests
  // immediately. Idempotent — revealing an already-revealed event no-ops.
  router.post('/:id/reveal', adminAuth, requirePermission('events.edit'), requireEventOwnership, async (req, res) => {
    try {
      const { id } = req.params;
      const event = await db('events').where('id', id).first();
      if (!event) {
        return res.status(404).json({ error: 'Event not found' });
      }
      const isOn = event.reveal_mode === true || event.reveal_mode === 1 || event.reveal_mode === '1';
      if (!isOn) {
        return res.status(400).json({ error: 'Reveal mode is not enabled for this event' });
      }

      const now = new Date().toISOString();
      // Also clear a pending schedule — "reveal now" makes it obsolete, and
      // a stale future reveal_at would re-arm hiding on the next form save.
      const stamped = await db('events')
        .where('id', id)
        .whereNull('revealed_at')
        .update({ revealed_at: now, reveal_at: null });

      if (stamped === 1) {
        await logActivity('gallery_revealed', { scheduled: false }, id, {
          type: 'admin', id: req.admin.id, name: req.admin.username,
        });
        try {
          await require('../../services/workflows').emitWorkflowEvent('gallery.revealed', {
            entityType: 'event',
            entityId: parseInt(id, 10),
            dedupSuffix: String(new Date(now).getTime()),
            payload: {
              eventId: parseInt(id, 10),
              slug: event.slug,
              eventName: event.event_name,
              revealedAt: now,
              scheduled: false,
            },
          });
        } catch (e) {
          logger.warn('Failed to emit gallery.revealed workflow event', { eventId: id, error: e.message });
        }
      }

      const fresh = await db('events').where('id', id).first();
      res.json({ message: 'Gallery revealed', revealed_at: fresh.revealed_at });
    } catch (error) {
      logger.error('Failed to reveal gallery:', error);
      res.status(500).json({ error: 'Failed to reveal gallery' });
    }
  });

  router.delete('/:id', adminAuth, requirePermission('events.delete'), requireEventOwnership, async (req, res) => {
    try {
      const { id } = req.params;
      await deleteEventCascade(id, { id: req.admin.id, username: req.admin.username });
      res.json({ message: 'Event deleted successfully' });
    } catch (error) {
      if (error.code === 'EVENT_NOT_FOUND') {
        return res.status(404).json({ error: 'Event not found' });
      }
      logger.error('Error deleting event', { eventId: req.params.id, error: error.message });
      if (error.message && error.message.includes('foreign key constraint')) {
        return res.status(500).json({
          error: 'Cannot delete event due to existing references. Please contact support.'
        });
      }
      res.status(500).json({ error: 'Failed to delete event' });
    }
  });

  // Toggle event status
  router.post('/:id/toggle-status', adminAuth, requirePermission('events.edit'), requireEventOwnership, async (req, res) => {
    try {
      const { id } = req.params;

      // Ownership: the rule requireEventOwnership already enforced, kept as
      // defence in depth (issue 1670, §2.4).
      const event = await scopeEventsQuery(db('events').where('id', id), req.admin).first();
      if (!event) {
        return res.status(404).json({ error: 'Event not found' });
      }

      const newStatus = !parseBooleanInput(event.is_active, false);
      await db('events')
        .where('id', id)
        .update({
          is_active: formatBoolean(newStatus),
          updated_at: new Date().toISOString()
        });

      // Log activity
      await logActivity(newStatus ? 'event_activated' : 'event_deactivated',
        { eventName: event.event_name },
        id,
        { type: 'admin', id: req.admin.id, name: req.admin.username }
      );

      res.json({ 
        message: `Event ${newStatus ? 'activated' : 'deactivated'} successfully`,
        is_active: newStatus
      });
    } catch (error) {
      errorResponse(res, error, 500, 'Failed to toggle event status');
    }
  });

  // Extend a gallery's expiration. Migrated from the legacy /api/events router
  // (removed — GHSA-4j34-x562-5vfq), now on the canonical mount with the same
  // permission + ownership guards as every other gallery mutation, so a
  // non-owning editor/viewer can no longer touch a gallery they don't own.
  router.post('/:id/extend', adminAuth, requirePermission('events.edit'), requireEventOwnership, [
    body('days').isInt({ min: 1, max: 365 })
  ], async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: safeValidationErrors(errors) });
      }

      const { id } = req.params;
      const { days } = req.body;

      // Ownership: the rule requireEventOwnership already enforced, kept as
      // defence in depth (issue 1670, §2.4).
      const event = await scopeEventsQuery(db('events').where('id', id), req.admin).first();
      if (!event) {
        return res.status(404).json({ error: 'Event not found' });
      }

      const newExpiration = new Date(event.expires_at);
      newExpiration.setDate(newExpiration.getDate() + days);

      await db('events').where('id', id).update({
        expires_at: newExpiration,
        is_active: formatBoolean(true) // reactivate if it had expired
      });

      await logActivity('event_expiration_extended',
        { eventName: event.event_name, days },
        id,
        { type: 'admin', id: req.admin.id, name: req.admin.username }
      );

      res.json({ expires_at: newExpiration });
    } catch (error) {
      errorResponse(res, error, 500, 'Failed to extend expiration');
    }
  });

};
