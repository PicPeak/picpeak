const { db, logActivity } = require('../database/db');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const logger = require('../utils/logger');
const { AppError } = require('../utils/errors');
const { formatBoolean } = require('../utils/dbCompat');
const { slugify } = require('../utils/slug');
const { validatePasswordInContext, getBcryptRounds } = require('../utils/passwordValidation');
const { buildShareLinkVariants } = require('./shareLinkService');
const { parseBooleanInput } = require('../utils/parsers');
const { normaliseEventTimeTriple } = require('./eventService');
const { hasColumnCached } = require('../utils/schemaCache');
const { getAppSetting } = require('../utils/appSettings');
const { galleryPasswordColumns, dropCopiesIfStorageOff } = require('../utils/galleryPasswordVault');
const { clampIntOrUndefined } = require('../utils/numericHelpers');
const { getFrontendBaseUrl } = require('../utils/frontendUrl');
const { resolveEventFeedbackDefaults, applyFeedbackDefaults } = require('./feedbackDefaults');
const { getStoragePath, getEventFieldRequirements, readBooleanSetting, getDownloadProtectionDefaults,
  getImageSecurityDefaults, resolveImageSecurityColumns, getBrandingDefaults, getCustomerNameFromPayload,
  getCustomerEmailFromPayload, getCustomerPhoneFromPayload, isPhoneFieldEnabled, hasCustomerContactColumns,
  SLIDESHOW_TRANSITIONS, SLIDESHOW_COLORFILTERS } = require('./eventSettings');
const { validateCreationInput } = require('./eventCreationValidation');
const { normaliseDownloadLimit } = require('./downloadQuota');
const { guestNameModeOf } = require('./photoCredit');
function creationError(body) {
  const error = new AppError(body.error || 'Invalid event', 400, 'EVENT_INVALID');
  error.responseBody = body;
  return error;
}

/** Shared creation operation. v1 explicitly publishes immediately and accepts
 * an optional absolute expiry; admin/legacy use configured field requirements.
 */
async function createEvent(data, { actor, source = 'admin', frontendUrl } = {}) {
  const input = await validateCreationInput(data);
  if (source === 'v1') input.is_draft = false;
  if (!actor || !Number.isInteger(actor.id)) throw new AppError('Event owner required', 400, 'EVENT_OWNER_REQUIRED');
  // Get field requirements from settings
  const fieldRequirements = source === 'v1'
    ? { require_expiration: false } : await getEventFieldRequirements();

  const {
    event_type,
    event_name,
    event_date,
    // Migration 137 — calendar time fields. is_full_day defaults to
    // true at the service layer when undefined (legacy form payloads).
    event_time_start,
    event_time_end,
    is_full_day,
    admin_email,
    password,
    welcome_message = '',
    color_theme = null,
    expiration_days = 30,
    allow_user_uploads = false,
    upload_category_id = null,
    // Uploader names (#1561). undefined = take the Event Defaults value.
    guest_name_mode: guestNameModeInput,
    show_credits_to_guests: showCreditsInput,
    allow_downloads = true,
    disable_right_click = false,
    enable_devtools_protection: enableDevtoolsProtectionInput,
    watermark_downloads = false,
    watermark_text = null,
    require_password: requirePasswordInput,
    // Feedback settings. The allow_* sub-toggles deliberately have NO
    // destructuring defaults: `undefined` means "the caller didn't say",
    // which inherits the global Settings > Events default (#1044). The
    // admin create form posts explicit values (it seeds its own panel
    // from the same globals), so inheritance here is what covers the v1
    // API and any other caller that omits them.
    feedback_enabled: feedbackEnabledInput,
    allow_ratings: allowRatingsInput,
    allow_likes: allowLikesInput,
    allow_comments: allowCommentsInput,
    allow_favorites: allowFavoritesInput,
    allow_reactions: allowReactionsInput,
    allow_color_labels: allowColorLabelsInput,
    keybind_mode: keybindModeInput,
    require_name_email = false,
    moderate_comments = true,
    show_feedback_to_guests = true,
    // The create form has always shown the identity-mode chooser and this
    // route has never read it, so a gallery created as 'guest' quietly came
    // out 'simple' and the photographer had to set it again on the event.
    // Surfaced by adding a third mode (#1197); the fix is the same for all
    // three. Unknown values fall back rather than reaching the column,
    // which on Postgres is guarded by a CHECK constraint.
    identity_mode: identityModeInput,
    // CSS Template
    css_template_id = null,
    // Hero logo settings
    hero_logo_visible = true,
    // Header style settings
    header_style = 'standard',
    hero_divider_style = 'wave',
    // Hero image anchor position (#162)
    hero_image_anchor = 'center',
    // Photo cap
    photo_cap = null,
    // Download limit (issue 1560). undefined = take the Event Defaults value.
    download_limit: downloadLimitInput,
    // Client access settings (#172)
    client_access_enabled = false,
    client_password = null,
    // Draft mode
    is_draft = source !== 'v1',
    // Default photo sort
    default_photo_sort = 'upload_date_desc',
    // Banner overrides (#440 / #932) — see the insert below.
    promo_mode = 'inherit',
    promo_markdown = null,
    info_mode = 'inherit',
    info_markdown = null
  } = input;

  const customerName = getCustomerNameFromPayload(input);
  const customerEmail = getCustomerEmailFromPayload(input);
  // Phone field is opt-in via the global setting (#322). If disabled,
  // ignore whatever the client posted — defence in depth against form
  // bypass.
  const phoneEnabled = await isPhoneFieldEnabled();
  const customerPhone = phoneEnabled ? getCustomerPhoneFromPayload(input) : null;

  const customerColumnsAvailable = await hasCustomerContactColumns();

  // Conditional validation based on settings
  const validationErrors = [];
  if (fieldRequirements.require_customer_name && !customerName) {
    validationErrors.push({ path: 'customer_name', msg: 'Customer name is required' });
  }
  if (fieldRequirements.require_customer_email && !customerEmail) {
    validationErrors.push({ path: 'customer_email', msg: 'Customer email is required' });
  }
  if (fieldRequirements.require_admin_email && !admin_email) {
    validationErrors.push({ path: 'admin_email', msg: 'Admin email is required' });
  }
  if (fieldRequirements.require_event_date && !event_date) {
    validationErrors.push({ path: 'event_date', msg: 'Event date is required' });
  }

  if (validationErrors.length > 0) {
    throw creationError({ errors: validationErrors });
  }

  // Default require_password from global "event_default_require_password"
  // setting when the body omits it (#317 — admins want to flip the default).
  let requirePasswordFallback = true;
  if (requirePasswordInput === undefined) {
    const setting = await readBooleanSetting('event_default_require_password');
    if (setting !== undefined) requirePasswordFallback = setting;
  }
  const requirePassword = parseBooleanInput(requirePasswordInput, requirePasswordFallback);

  // Default feedback_enabled from global "event_default_feedback_enabled"
  // setting when the body omits it (#520 — same pattern as require_password
  // above, lets admins make Guest Feedback ON the out-of-box default for
  // new events instead of toggling it on every time).
  let feedbackEnabledFallback = false;
  if (feedbackEnabledInput === undefined) {
    const setting = await readBooleanSetting('event_default_feedback_enabled');
    if (setting !== undefined) feedbackEnabledFallback = setting;
  }
  const feedback_enabled = parseBooleanInput(feedbackEnabledInput, feedbackEnabledFallback);

  // Default download limit from Settings > Event Defaults when the body omits
  // it (issue 1560). An explicit null still means unlimited.
  const download_limit = downloadLimitInput === undefined
    ? normaliseDownloadLimit(await getAppSetting('event_default_download_limit', null))
    : normaliseDownloadLimit(downloadLimitInput);

  // Uploader-name defaults from Settings > Event Defaults (#1561); an
  // explicitly-sent body value still wins.
  const guest_name_mode = guestNameModeOf({
    guest_name_mode: guestNameModeInput === undefined
      ? await getAppSetting('event_default_guest_name_mode', 'off')
      : guestNameModeInput,
  });
  let showCreditsFallback = false;
  if (showCreditsInput === undefined) {
    const setting = await readBooleanSetting('event_default_show_credits_to_guests');
    if (setting !== undefined) showCreditsFallback = setting;
  }
  const show_credits_to_guests = parseBooleanInput(showCreditsInput, showCreditsFallback);

  // Sub-toggle defaults from the global Settings > Events values (#1044).
  // One batched read; an explicitly-sent body value still wins.
  const feedbackDefaults = applyFeedbackDefaults({
    allow_ratings: allowRatingsInput,
    allow_likes: allowLikesInput,
    allow_comments: allowCommentsInput,
    allow_favorites: allowFavoritesInput,
    allow_reactions: allowReactionsInput,
    allow_color_labels: allowColorLabelsInput,
    keybind_mode: keybindModeInput,
  }, await resolveEventFeedbackDefaults());

  let passwordValidation = null;

  if (requirePassword) {
    // The v1 route validator marks password optional; the admin route's
    // custom() guard is not shared, so enforce presence here for every path.
    if (typeof password !== 'string' || password.length === 0) {
      throw creationError({ error: 'Password is required when require_password is true' });
    }
    passwordValidation = await validatePasswordInContext(password, 'gallery', {
      eventName: event_name
    });

    if (!passwordValidation.valid) {
      throw creationError({ 
        error: 'Password does not meet security requirements',
        details: passwordValidation.errors,
        score: passwordValidation.score,
        feedback: passwordValidation.feedback
      });
    }
  }
    
  // Generate unique slug. Uses the shared util so accented names
  // (Família, Decoração, etc.) get transliterated instead of dropped
  // — see backend/src/utils/slug.js for the why (#525).
  const processedEventName = slugify(event_name);

  // Use event_date in slug if provided, otherwise use random suffix
  const slugSuffix = event_date || crypto.randomBytes(3).toString('hex');
  const baseSlug = `${event_type}-${processedEventName}-${slugSuffix}`;
  let slug = baseSlug;
  let counter = 1;

  while (await db('events').where({ slug }).first()) {
    slug = `${baseSlug}-${counter}`;
    counter++;
  }
    
  // Generate share link respecting configured format
  const shareToken = crypto.randomBytes(16).toString('hex');
  const { shareUrl, shareLinkToStore } = await buildShareLinkVariants({ slug, shareToken });
    
  // Hash password with configurable rounds (random placeholder when not required)
  const password_hash = requirePassword
    ? await bcrypt.hash(password, getBcryptRounds())
    : await bcrypt.hash(crypto.randomBytes(32).toString('hex'), getBcryptRounds());
    
  // Calculate expiration date (days after event date)
  // If expiration is not required, expires_at will be null (never expires)
  // If event_date is not provided, use current date as base for expiration
  let expires_at = input.expires_at ? new Date(input.expires_at) : null;
  if (!expires_at && fieldRequirements.require_expiration) {
    const baseDate = event_date || new Date().toISOString().split('T')[0];
    // Parse YYYY-MM-DD format as local date to avoid timezone issues
    if (baseDate.match(/^\d{4}-\d{2}-\d{2}$/)) {
      const [year, month, day] = baseDate.split('-').map(num => parseInt(num, 10));
      expires_at = new Date(year, month - 1, day);
    } else {
      expires_at = new Date(baseDate);
    }
    expires_at.setDate(expires_at.getDate() + parseInt(expiration_days, 10));
  }
    
  // Create folder structure
  const storagePath = getStoragePath();
  const eventPath = path.join(storagePath, 'events/active', slug);
  await fs.mkdir(path.join(eventPath, 'collages'), { recursive: true });
  await fs.mkdir(path.join(eventPath, 'individual'), { recursive: true });
    
  // Sync header_style / hero_divider_style from color_theme JSON when not
  // explicitly provided in the request body (#158).
  let effectiveHeaderStyle = header_style;
  let effectiveDividerStyle = hero_divider_style;
  if (color_theme && (!input.header_style || !input.hero_divider_style)) {
    try {
      if (typeof color_theme === 'string' && color_theme.startsWith('{')) {
        const parsed = JSON.parse(color_theme);
        if (!input.header_style && parsed.headerStyle) {
          effectiveHeaderStyle = parsed.headerStyle;
        }
        if (!input.hero_divider_style && parsed.heroDividerStyle) {
          effectiveDividerStyle = parsed.heroDividerStyle;
        }
      }
    } catch (_) {
      // color_theme is not JSON – nothing to extract
    }
  }

  // Get branding defaults for hero logo settings (Feature 7: Branding Inheritance)
  const brandingDefaults = await getBrandingDefaults();
  // hero_logo_visible: store NULL ("inherit") unless the admin explicitly
  // set it, so the global branding_logo_display_hero toggle keeps
  // controlling this gallery afterwards (#756). Only an explicit per-event
  // choice overrides the global. `!= null` treats an explicit null the same
  // as omitted (both → inherit); otherwise formatBoolean(null) would coerce
  // to 0/false on SQLite instead of NULL (the PUT handler already does this).
  const effectiveHeroLogoVisible = input.hero_logo_visible != null
    ? formatBoolean(hero_logo_visible)
    : null;
  // NULL = inherit the global branding_logo_size (#756), resolved at read
  // time. Only an explicit per-event size overrides it.
  const effectiveHeroLogoSize = input.hero_logo_size || null;
  const effectiveHeroLogoPosition = input.hero_logo_position || brandingDefaults.hero_logo_position;

  // Inherit "Detect dev tools" from the global Image Security setting unless
  // the request explicitly overrides it (#317 — admin disabled it globally
  // but new events still got it ON because the column default is true).
  const protectionDefaults = await getDownloadProtectionDefaults();
  // #1296 — the other four Image-security settings, which were written,
  // rendered as controls, and read by nothing. Same inheritance rule as
  // the devtools setting below. Creation-time only; see
  // getImageSecurityDefaults for why existing events are left alone.
  const imageSecurityColumns = resolveImageSecurityColumns(
    input,
    await getImageSecurityDefaults(),
  );
  const effectiveEnableDevtoolsProtection =
      enableDevtoolsProtectionInput !== undefined
        ? enableDevtoolsProtectionInput
        : protectionDefaults.enable_devtools_protection !== undefined
          ? protectionDefaults.enable_devtools_protection
          : true;

  // Migration 137 — normalise calendar time triple. Throws AppError
  // 400 when is_full_day=false but times are malformed/inverted.
  const calendarTriple = normaliseEventTimeTriple({
    event_time_start, event_time_end, is_full_day,
  });
  const calendarColumnsExist = await hasColumnCached('events', 'is_full_day');

  // Insert into database
  // Seed the new event's Live Slideshow display style from the PICPEAK-WIDE
  // preset (app_settings, Settings → Slideshow). New events inherit it and the
  // admin can still override per event. Watermark is left NULL = inherit the
  // global watermark; the share token is minted on demand, not seeded. Guarded
  // so un-migrated installs (mid-branch) don't reference missing columns.
  let slideshowSeed = {};
  if (await hasColumnCached('events', 'show_interval_ms')) {
    try {
      // parseInt-first: the previous `Number.isFinite(+v)` pre-check let
      // NaN through for null/''/true (+null is 0, parseInt(null) is NaN),
      // producing show_interval_ms=NaN in the INSERT — PG rejects that
      // with "invalid input syntax for type integer" while SQLite
      // silently stores NULL, so event creation 500'd on PG whenever the
      // slideshow app_settings rows were absent.
      const intP = (v, min, max) => clampIntOrUndefined(v, min, max);
      const oneOf = (v, allowed) => (allowed.includes(v) ? v : undefined);
      const i = intP(await getAppSetting('slideshow_interval_ms', undefined), 1000, 120000);
      const tr = oneOf(await getAppSetting('slideshow_transition', undefined), SLIDESHOW_TRANSITIONS);
      const tms = intP(await getAppSetting('slideshow_transition_ms', undefined), 100, 5000);
      const cf = oneOf(await getAppSetting('slideshow_colorfilter', undefined), SLIDESHOW_COLORFILTERS);
      if (i !== undefined) slideshowSeed.show_interval_ms = i;
      if (tr) slideshowSeed.show_transition = tr;
      if (tms !== undefined) slideshowSeed.show_transition_ms = tms;
      if (cf) slideshowSeed.show_colorfilter = cf;
    } catch (e) {
      logger.warn('Failed to seed slideshow settings from global preset', { error: e.message });
    }
  }

  const insertData = {
    slug,
    event_type,
    event_name,
    ...slideshowSeed,
    event_date: event_date || null,
    ...(calendarColumnsExist ? {
      event_time_start: calendarTriple.event_time_start,
      event_time_end: calendarTriple.event_time_end,
      is_full_day: formatBoolean(calendarTriple.is_full_day),
    } : {}),
    ...(customerColumnsAvailable ? { customer_name: customerName, customer_email: customerEmail } : {}),
    ...(customerPhone ? { customer_phone: customerPhone } : {}),
    host_name: customerName || null,
    host_email: customerEmail || null,
    admin_email: admin_email || null,
    password_hash,
    // Opt-in recoverable copy (#1271), written with the hash so the two
    // can never disagree. Empty unless the security setting is on.
    ...(await galleryPasswordColumns({
      ...(requirePassword && password ? { password } : {}),
      ...(client_access_enabled && client_password ? { clientPassword: client_password } : {}),
    })),
    welcome_message,
    color_theme,
    share_link: shareLinkToStore,
    share_token: shareToken,
    expires_at: expires_at ? expires_at.toISOString() : null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    created_by: actor.id,
    allow_user_uploads: formatBoolean(allow_user_uploads),
    upload_category_id,
    guest_name_mode,
    show_credits_to_guests: formatBoolean(show_credits_to_guests),
    allow_downloads: formatBoolean(allow_downloads !== undefined ? allow_downloads : true),
    disable_right_click: formatBoolean(disable_right_click !== undefined ? disable_right_click : false),
    enable_devtools_protection: formatBoolean(effectiveEnableDevtoolsProtection),
    // Request value, else the global default, else the column default —
    // a key absent here is one the database fills in (#1296).
    ...imageSecurityColumns,
    watermark_downloads: formatBoolean(watermark_downloads !== undefined ? watermark_downloads : false),
    watermark_text,
    require_password: formatBoolean(requirePassword),
    css_template_id: css_template_id || null,
    // Already formatBoolean-coerced above, or null = inherit global (#756).
    hero_logo_visible: effectiveHeroLogoVisible,
    hero_logo_size: effectiveHeroLogoSize,
    hero_logo_position: effectiveHeroLogoPosition,
    // Banner overrides. Both were accepted by the validators above and
    // then dropped here, so an API client could POST info_mode:'off' or a
    // custom banner, get 201, and find the row still on 'inherit'.
    // Markdown is only stored for 'custom' — same rule the PUT applies.
    promo_mode: ['inherit', 'custom', 'off'].includes(promo_mode) ? promo_mode : 'inherit',
    promo_markdown: promo_mode === 'custom' && typeof promo_markdown === 'string' && promo_markdown.trim()
      ? promo_markdown.trim() : null,
    info_mode: ['inherit', 'custom', 'off'].includes(info_mode) ? info_mode : 'inherit',
    info_markdown: info_mode === 'custom' && typeof info_markdown === 'string' && info_markdown.trim()
      ? info_markdown.trim() : null,
    header_style: effectiveHeaderStyle || 'standard',
    hero_divider_style: effectiveDividerStyle || 'wave',
    hero_image_anchor: hero_image_anchor || 'center',
    photo_cap: photo_cap || null,
    download_limit,
    is_draft: formatBoolean(parseBooleanInput(is_draft, true)),
    default_photo_sort: default_photo_sort || 'upload_date_desc',
    // Client access (#172)
    client_access_enabled: formatBoolean(client_access_enabled),
    ...(client_access_enabled && client_password ? {
      client_password_hash: await bcrypt.hash(client_password, getBcryptRounds()),
      client_share_token: crypto.randomBytes(32).toString('hex')
    } : {}),
    // Per-event opt-in for hero-photo OG share image (#474). Defaults
    // false on create — admin opts in from the event detail page once
    // they've picked a hero they're comfortable surfacing publicly.
    og_image_share_enabled: formatBoolean(input.og_image_share_enabled === true),
  };
    
  // The gallery row and its feedback configuration commit together.
  const eventId = await db.transaction(async trx => {
    const result = await trx('events').insert(insertData).returning('id');
    const eventId = result[0]?.id ?? result[0];
    // Insert feedback settings if feedback is enabled
    if (feedback_enabled) {
      await trx('event_feedback_settings').insert({
        event_id: eventId,
        feedback_enabled: formatBoolean(feedback_enabled),
        allow_ratings: formatBoolean(feedbackDefaults.allow_ratings),
        allow_likes: formatBoolean(feedbackDefaults.allow_likes),
        allow_comments: formatBoolean(feedbackDefaults.allow_comments),
        allow_favorites: formatBoolean(feedbackDefaults.allow_favorites),
        allow_reactions: formatBoolean(feedbackDefaults.allow_reactions),
        allow_color_labels: formatBoolean(feedbackDefaults.allow_color_labels),
        keybind_mode: feedbackDefaults.keybind_mode,
        require_name_email: formatBoolean(require_name_email),
        moderate_comments: formatBoolean(moderate_comments),
        show_feedback_to_guests: formatBoolean(show_feedback_to_guests),
        identity_mode: ['simple', 'guest', 'shared'].includes(identityModeInput)
          ? identityModeInput
          : 'simple',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      });
    }
    
    return eventId;
  });
  // #1271 — the setting was read before the hashes; re-check after the write
  await dropCopiesIfStorageOff(eventId);

  // Apply customer-account assignments (#354). Skip when the customer
  // portal flag is off — the frontend hides the picker in that case,
  // but a stale tab could still POST customer_account_ids; we ignore
  // them rather than 403 the entire create.
  if (Array.isArray(input.customer_account_ids)) {
    try {
      const customerAccountsService = require('./customerAccountsService');
      if (await customerAccountsService.isCustomerPortalEnabled()) {
        await customerAccountsService.setAssignmentsForEvent(
          eventId,
          input.customer_account_ids,
          actor.id
        );
      }
    } catch (e) {
      logger.error('Failed to set customer assignments on event create', {
        eventId, error: e.message,
      });
    }
  }

  // Log activity
  await logActivity('event_created',
    { event_type, expires_at, require_password: requirePassword, password_strength: passwordValidation?.score },
    eventId,
    { type: 'admin', id: actor.id, name: actor.username }
  );

  // Fire event.created webhook (#327). If the event is being published
  // immediately (not a draft), event.published also fires below.
  // Payload uses canonical event subject (#341) so receivers always see
  // the same shape (id/slug/event_name + customer contact + share_*).
  try {
    const webhookService = require('./webhookService');
    await webhookService.fire('event.created', {
      event: {
        ...webhookService.buildEventSubject({
          id: eventId,
          slug,
          event_name,
          event_type,
          event_date,
          share_url: shareUrl,
          share_token: shareToken,
          customer_name: customerName,
          customer_email: customerEmail,
          customer_phone: customerPhone,
        }),
        is_draft: parseBooleanInput(is_draft, true),
      },
    });
  } catch (e) { /* webhookService.fire never throws but be defensive */ }

  // Queue creation email (only if there is a recipient and event is not a draft)
  // Language detection is handled by email processor
  const isDraft = parseBooleanInput(is_draft, true);

  if (customerEmail && !isDraft) {
    // Build email data with optional client access info
    const emailData = {
      customer_name: customerName,
      customer_email: customerEmail,
      host_name: customerName || (customerEmail ? customerEmail.split('@')[0] : null),
      event_name,
      event_date: event_date,  // Pass raw date - will be formatted by email processor
      gallery_link: shareUrl,
      gallery_password: requirePassword ? password : 'No password required',
      expiry_date: expires_at ? expires_at.toISOString() : null,  // Pass ISO string - will be formatted by email processor
      welcome_message: welcome_message || ''
    };

    // Include client access info in email when enabled (#172)
    if (client_access_enabled && client_password) {
      const createdEvent = await db('events').where('id', eventId).first();
      // Same FRONTEND_URL-before-APP_URL order as before: APP_URL is
      // passed as the override so it still outranks the general_site_url
      // setting and the request origin. Chaining it after the resolver
      // would make it dead code, because the resolver only returns falsy
      // when NOTHING is configured (#1104).
      const resolvedFrontendUrl = frontendUrl || await getFrontendBaseUrl();
      emailData.client_link = `${resolvedFrontendUrl}/gallery/${slug}/client-access?token=${createdEvent.client_share_token}`;
      emailData.client_password = client_password;
    }

    // Best-effort, as the v1 route always was: the event, folder, activity
    // log and webhook are committed by now, so a queue failure must not 500.
    try {
      await db('email_queue').insert({
        event_id: eventId,
        recipient_email: customerEmail,
        email_type: 'gallery_created',
        email_data: JSON.stringify(emailData),
        status: 'pending',
        created_at: new Date(),
        // Explicit NULL, not the column default: on SQLite the default is
        // text and the processor never picks the row up (issue 1670).
        scheduled_at: null
      });
    } catch (queueError) {
      logger.warn('Failed to queue gallery_created email on create', { eventId, error: queueError.message });
    }
  }

  // WhatsApp gallery_ready notification (#640D). Fires when the event is
  // created NOT as a draft, the `whatsapp` flag is on, a config exists, and
  // the customer supplied a phone number. Non-fatal: a queue failure should
  // never block gallery creation.
  if (!isDraft && customerPhone) {
    try {
      const { queueWhatsapp, getWhatsAppConfig } = require('./whatsappProcessor');
      const waConfig = await getWhatsAppConfig();
      if (waConfig && waConfig.enabled) {
        await queueWhatsapp(eventId, customerPhone, 'gallery_created', {
          customer_name: customerName || '',
          event_name,
          gallery_link: shareUrl,
          gallery_password: requirePassword ? password : '',
          expiry_date: expires_at ? expires_at.toISOString() : null,
          language: null, // resolved by processor via general_default_language
        });
      }
    } catch (waError) {
      logger.warn('Failed to queue WhatsApp notification on create', { error: waError.message });
    }
  }

  // Fire event.published when the event is created NOT as a draft. The
  // separate /publish endpoint fires it for the draft → live transition;
  // this covers the "create-and-publish in one shot" path.
  if (!isDraft) {
    try {
      const webhookService = require('./webhookService');
      await webhookService.fire('event.published', {
        event: webhookService.buildEventSubject({
          id: eventId,
          slug,
          event_name,
          event_type,
          event_date,
          share_url: shareUrl,
          share_token: shareToken,
          customer_name: customerName,
          customer_email: customerEmail,
          customer_phone: customerPhone,
        }),
      });
    } catch (e) { /* non-fatal */ }
  }

  if (!isDraft) {
    await require('./workflows').emitWorkflowEvent('gallery.published', {
      entityType: 'event', entityId: eventId,
      payload: { eventId, slug, eventName: event_name, eventDate: event_date,
        customerEmail, adminEmail: admin_email, galleryLink: shareUrl,
        expiresAt: expires_at ? expires_at.toISOString() : null },
    }).catch(error => logger.warn('Failed to emit gallery.published', { eventId, error: error.message }));
  }

  return {
    id: eventId,
    slug,
    event_name,
    event_type,
    customer_name: customerName,
    customer_email: customerEmail,
    require_password: requirePassword,
    photo_cap: photo_cap || null,
    download_limit,
    is_draft: isDraft,
    share_link: shareUrl,
    share_token: shareToken,
    expires_at: expires_at ? expires_at.toISOString() : null,
    created_at: new Date().toISOString()
  };
}

module.exports = { createEvent };
