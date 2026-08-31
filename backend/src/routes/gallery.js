const express = require('express');
const jwt = require('jsonwebtoken');
const { db } = require('../database/db');
const { formatBoolean } = require('../utils/dbCompat');
// SQLite stores booleans as 0/1, Postgres as true/false (#1028). Strict
// comparisons against `true`/`false` therefore read every flag backwards on
// SQLite — parseBooleanInput normalises both engines and takes the per-column
// default for legacy NULL rows.
const { parseBooleanInput } = require('../utils/parsers');
const { getAppSetting } = require('../utils/appSettings');
const archiver = require('archiver');
const path = require('path');
const router = express.Router();

// #756: a NULL per-event hero_logo_visible means "inherit the global
// branding_logo_display_hero toggle". Only an explicit true/false is a
// per-gallery override. `globalDefault` is branding_logo_display_hero
// (defaults true when unset).
function resolveHeroLogoVisible(perEvent, globalDefault) {
  if (perEvent === null || perEvent === undefined) {
    return globalDefault !== false;
  }
  return perEvent !== false && perEvent !== 0 && perEvent !== '0';
}
const watermarkService = require('../services/watermarkService');
const watermarkGeneratorService = require('../services/watermarkGeneratorService');
const { verifyGalleryAccess, denySlideshowToken, isAdminPreview } = require('../middleware/gallery');
const { resolveGuest } = require('../middleware/guestAuth');
const { generateGuestIdentifier } = require('../middleware/feedbackRateLimit');
const secureImageService = require('../services/secureImageService');
const logger = require('../utils/logger');
const { pipeStreamToResponse } = require('../utils/streamResponse');
const { resolvePhotoFilePath, resolvePhotoStorageKey } = require('../services/photoResolver');
const { getEventShareToken, resolveShareIdentifier, buildShareLinkVariants } = require('../services/shareLinkService');
const { handleAsync, errorResponse } = require('../utils/routeHelpers');
const { NotFoundError } = require('../utils/errors');
const { ensureThumbnail, ensureHeroImage, ensurePreviewImage, withLocalCopy } = require('../services/imageProcessor');
const downloadZipService = require('../services/downloadZipService');
const { applyPhotoVisibilityFilter, canSeeHiddenPhotos } = require('../utils/photoVisibility');
const {
  getUseOriginalFilenames,
  pickRawDownloadName,
  getZipEntryNames,
} = require('../services/downloadFilenameService');
const { buildContentDisposition } = require('../utils/filenameSanitizer');
const { getStorage } = require('../services/storage');
const { setGalleryAuthCookies } = require('../utils/tokenUtils');
// Read globals from app_settings (the real table) — settingsService.getSetting
// queries a non-existent `settings` table and throws.
const { getSlideshowGlobals } = require('../utils/slideshowGlobals');
const { isFeatureEnabled } = require('../middleware/requireFeatureFlag');
const fs = require('fs');

// Get storage path from environment or default
const getStoragePath = () => process.env.STORAGE_PATH || path.join(__dirname, '../../../storage');

/**
 * Parse a single-range `Range: bytes=` header against a known size.
 *
 * Returns null for absent, malformed, multi-range or unsatisfiable headers —
 * every one of which the caller answers with a normal 200 full body, which is
 * what a client that sent an unparseable range would get today anyway.
 * Validating matters because an unchecked parse yields NaN bounds and a 206
 * with a nonsense Content-Range, which corrupts a resumed download rather
 * than merely failing it.
 */
function parseByteRange(header, size) {
  if (!header || typeof header !== 'string' || !size) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;

  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return null;

  let start;
  let end;
  if (rawStart === '') {
    // Suffix form: the last N bytes.
    const suffix = parseInt(rawEnd, 10);
    if (!suffix) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = parseInt(rawStart, 10);
    end = rawEnd === '' ? size - 1 : parseInt(rawEnd, 10);
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start > end || start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
}


// Check for slug redirect (for renamed events)
async function checkSlugRedirect(slug) {
  try {
    const hasTable = await db.schema.hasTable('slug_redirects');
    if (!hasTable) return null;

    const redirect = await db('slug_redirects')
      .where({ old_slug: slug })
      .first();

    return redirect ? redirect.new_slug : null;
  } catch (error) {
    logger.warn('Error checking slug redirect:', { slug, error: error.message });
    return null;
  }
}

// Resolve gallery identifier (slug or token) to canonical data
router.get('/resolve/:identifier', handleAsync(async (req, res) => {
  const { identifier } = req.params;
  let result = await resolveShareIdentifier(identifier);

  // If not found, check for redirect
  if (!result) {
    const newSlug = await checkSlugRedirect(identifier);
    if (newSlug) {
      return res.status(301).json({
        redirect: true,
        newSlug,
        message: 'Gallery has been renamed'
      });
    }
    throw new NotFoundError('Gallery');
  }

  const { event, matchType, shareToken } = result;
  const requiresPassword = !(event.require_password === false || event.require_password === 0 || event.require_password === '0');

  // The share_token is a bearer secret. Only return it (and the share
  // links/URLs that embed it) when the caller already proved they hold it —
  // i.e. they resolved via the token or the full share link. A bare *slug*
  // lookup (slugs appear in gallery URLs and are guessable) must NOT hand
  // back the secret, or an anonymous caller could turn a known slug into
  // share-link access to a no-password gallery (GHSA-rh8r).
  const callerHasToken = matchType !== 'slug';
  if (!callerHasToken) {
    return res.json({ slug: event.slug, matchType, requires_password: requiresPassword });
  }

  const linkVariants = await buildShareLinkVariants({ slug: event.slug, shareToken });
  res.json({
    slug: event.slug,
    token: shareToken,
    matchType,
    share_link: event.share_link,
    share_path: linkVariants.sharePath,
    share_url: linkVariants.shareUrl,
    short_enabled: linkVariants.shortEnabled,
    requires_password: requiresPassword
  });
}));

// Verify share token
router.get('/:slug/verify-token/:token', handleAsync(async (req, res) => {
  const { slug, token } = req.params;

  const event = await db('events')
    .where({ slug, is_active: formatBoolean(true), is_archived: formatBoolean(false), is_draft: formatBoolean(false) })
    .select('id', 'share_link', 'share_token')
    .first();

  if (!event) {
    throw new NotFoundError('Gallery');
  }

  const expectedToken = getEventShareToken(event);
  if (token !== expectedToken) {
    throw new NotFoundError('Gallery', 'Invalid gallery link');
  }

  res.json({ valid: true });
}));

// Get gallery info (with optional token verification)
router.get('/:slug/info', async (req, res) => {
  try {
    const { slug } = req.params;
    const { token } = req.query;

    let event = await db('events')
      .where({ slug })
      .select(
        'event_name',
        'event_type',
        'event_date',
        'expires_at',
        'is_active',
        'is_archived',
        'share_link',
        'share_token',
        'allow_downloads',
        'allow_user_uploads',
        'disable_right_click',
        'watermark_downloads',
        'watermark_text',
        'require_password',
        'color_theme',
        'enable_devtools_protection',
        'use_canvas_rendering',
        'hero_logo_visible',
        'hero_logo_size',
        'hero_logo_position',
        'hero_logo_url',
        'header_style',
        'hero_divider_style',
        'hero_image_anchor',
        'is_draft',
        'default_photo_sort',
        // Per-event promotional override (#440). Resolution into a
        // ready-to-render markdown string happens below so the
        // frontend doesn't have to know about modes.
        'promo_mode',
        'promo_markdown'
      )
      .first();

    if (!event) {
      // Check for redirect
      const newSlug = await checkSlugRedirect(slug);
      if (newSlug) {
        return res.status(301).json({
          redirect: true,
          newSlug,
          message: 'Gallery has been renamed'
        });
      }
      return res.status(404).json({ error: 'Gallery not found' });
    }

    // Check if event is archived
    if (event.is_archived) {
      return res.status(404).json({ error: 'Gallery has been archived and is no longer available' });
    }

    // Check if event is a draft (allow admin preview)
    if (event.is_draft && !isAdminPreview(req)) {
      return res.status(404).json({ error: 'Gallery is not yet published' });
    }
    
    // If token provided, verify it matches the share link
    if (token) {
      const expectedToken = getEventShareToken(event);
      if (!expectedToken || token !== expectedToken) {
        return res.status(404).json({ error: 'Invalid gallery link' });
      }
    }
    
    const requiresPassword = !(event.require_password === false || event.require_password === 0 || event.require_password === '0');
    const globalHeroLogoVisible = await getAppSetting('branding_logo_display_hero', true);
    const globalLogoSize = await getAppSetting('branding_logo_size', 'medium');

    res.json({
      event_name: event.event_name,
      event_type: event.event_type,
      event_date: event.event_date,
      expires_at: event.expires_at,
      is_active: event.is_active,
      is_expired: !event.is_active || (event.expires_at && new Date(event.expires_at) < new Date()),
      requires_password: requiresPassword,
      color_theme: event.color_theme,
      allow_downloads: !(event.allow_downloads === false || event.allow_downloads === 0 || event.allow_downloads === '0'),
      allow_user_uploads: event.allow_user_uploads === true || event.allow_user_uploads === 1 || event.allow_user_uploads === '1',
      disable_right_click: event.disable_right_click === true || event.disable_right_click === 1 || event.disable_right_click === '1',
      watermark_downloads: event.watermark_downloads === true || event.watermark_downloads === 1 || event.watermark_downloads === '1',
      watermark_text: event.watermark_text,
      enable_devtools_protection: event.enable_devtools_protection === true || event.enable_devtools_protection === 1 || event.enable_devtools_protection === '1',
      use_canvas_rendering: event.use_canvas_rendering === true || event.use_canvas_rendering === 1 || event.use_canvas_rendering === '1',
      hero_logo_visible: resolveHeroLogoVisible(event.hero_logo_visible, globalHeroLogoVisible),
      // #756: NULL per-event size inherits the global branding_logo_size.
      hero_logo_size: event.hero_logo_size || globalLogoSize || 'medium',
      hero_logo_position: event.hero_logo_position || 'top',
      hero_logo_url: event.hero_logo_url || null,
      header_style: event.header_style || 'standard',
      hero_divider_style: event.hero_divider_style || 'wave',
      hero_image_anchor: event.hero_image_anchor || 'center',
      default_photo_sort: event.default_photo_sort || 'upload_date_desc',
      // Per-event promotional override (#440). Frontend resolves
      // 'inherit' against branding_promo_markdown from public settings.
      promo_mode: event.promo_mode || 'inherit',
      promo_markdown: event.promo_markdown || null
    });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to fetch gallery info');
  }
});

// ---------------------------------------------------------------------------
// Live Slideshow ("Diashow") — token-only fullscreen kiosk surface
// (migration 138). The token in the URL IS the secret (no gallery password),
// so these routes are unauthenticated except for the token match itself. The
// slideshow shows ALL public/visible, finished photos — exactly the guest
// set — so once /session mints a short-lived `accessLevel:'slideshow'` JWT,
// the page reuses the normal /photos + image endpoints unchanged.
// ---------------------------------------------------------------------------

// Photos a slideshow may display: published, finished, non-hidden. Mirrors the
// guest filter in GET /:slug/photos so the live count matches the rendered set.
function slideshowPhotosQuery(eventId) {
  return db('photos')
    .where('photos.event_id', eventId)
    .where(function() {
      this.where('photos.processing_status', 'complete').orWhereNull('photos.processing_status');
    })
    .where(function() {
      this.where('photos.visibility', 'visible').orWhereNull('photos.visibility');
    });
}

// Resolve an active slideshow by slug + token. Returns the event row, or null
// when the link is missing/rotated/disabled or the gallery isn't live (archived
// / draft / inactive / expired) — every one of those collapses to a 404 so a
// dead link reveals nothing and stops any projector on its next poll.
async function resolveSlideshow(slug, token) {
  if (!token) return null;
  // The `slideshow` feature flag is a master kill-switch: when an admin turns
  // Live Slideshow off, every existing /show/ link dies on its next request
  // (the running projector stops within one /state poll), not just the admin UI.
  if (!(await isFeatureEnabled('slideshow'))) return null;
  const event = await db('events')
    .where({
      slug,
      show_share_token: token,
      is_active: formatBoolean(true),
      is_archived: formatBoolean(false),
      is_draft: formatBoolean(false)
    })
    .first();
  if (!event) return null;
  if (event.expires_at && new Date(event.expires_at) < new Date()) return null;
  return event;
}

// Resolve the slideshow's live styling, including the ZDF/ARD-ident-style
// watermark (a white, semi-transparent corner logo). The logo URL is resolved
// from the chosen source so the kiosk renders it without knowing about
// branding/event internals; null url = nothing to overlay.
async function slideshowSettings(event) {
  // The global look/fit (Settings → Slideshow) + branding logo URLs come from a
  // short-TTL cached bundle so a 3s projector poll doesn't re-fire ~10 settings
  // reads each time (PR #646 review, concern 2).
  const g = await getSlideshowGlobals();

  // Watermark: the LOOK (logo/position/opacity/style/size) is configured ONCE
  // globally; it is NOT duplicated per event. The only per-event control is
  // whether the watermark shows: `show_watermark` NULL inherits the global
  // enabled flag, true/false force it on/off.
  const wm = event.show_watermark;
  const inherit = (wm === null || wm === undefined);
  const enabled = inherit ? g.watermark_enabled : (wm === true || wm === 1 || wm === '1');
  let watermark = null;
  if (enabled) {
    // Resolve the chosen logo to a URL. Branding assets come from settings;
    // the event source uses the event's own hero logo.
    let url;
    if (g.watermark_source === 'event') {
      url = event.hero_logo_url || null;
    } else if (g.watermark_source === 'logo_dark') {
      url = g.branding_logo_url_dark;
    } else if (g.watermark_source === 'favicon') {
      url = g.branding_favicon_url;
    } else {
      url = g.branding_logo_url;
    }
    if (url) {
      watermark = {
        url,
        position: g.watermark_position,
        opacity: g.watermark_opacity,
        style: g.watermark_style,
        size: g.watermark_size,
      };
    }
  }
  return {
    interval_ms: event.show_interval_ms || 5000,
    transition: event.show_transition || 'crossfade',
    transition_ms: event.show_transition_ms || 800,
    colorfilter: event.show_colorfilter || 'none',
    fit: g.fit,
    watermark,
  };
}

// Open a slideshow session: validate the token and mint a short-lived gallery
// JWT scoped to `accessLevel:'slideshow'` (treated as a guest by the photo /
// image endpoints → visible photos only, no client-only/hidden). The page
// stores this token and the existing axios interceptor injects it.
router.get('/:slug/show/:token/session', handleAsync(async (req, res) => {
  const { slug, token } = req.params;
  const event = await resolveSlideshow(slug, token);
  if (!event) {
    throw new NotFoundError('Slideshow');
  }

  const sessionToken = jwt.sign({
    eventId: event.id,
    eventSlug: event.slug,
    type: 'gallery',
    accessLevel: 'slideshow',
    loginTime: Date.now()
  }, process.env.JWT_SECRET, {
    expiresIn: '12h',
    issuer: 'picpeak-auth'
  });

  // <img> tags can't carry an Authorization header, so the photo/thumbnail/
  // preview endpoints authenticate via the per-slug gallery cookie. Set it
  // here so the kiosk's image requests are authorized with zero extra wiring.
  setGalleryAuthCookies(res, sessionToken, event.slug);

  const [{ count }] = await slideshowPhotosQuery(event.id).count('* as count');

  res.json({
    token: sessionToken,
    event: {
      event_name: event.event_name,
      event_type: event.event_type,
      color_theme: event.color_theme
    },
    settings: await slideshowSettings(event),
    photo_count: parseInt(count, 10) || 0,
    expires_at: event.expires_at || null
  });
}));

// Cheap live-poll endpoint (tiny payload, hit every ~3s by the running show):
// current settings + the visible photo count. The page diffs photo_count to
// decide when to refetch the full list, and re-reads settings so admin changes
// take effect live. A dead/disabled link 404s here → the projector stops.
router.get('/:slug/show/:token/state', handleAsync(async (req, res) => {
  const { slug, token } = req.params;
  const event = await resolveSlideshow(slug, token);
  if (!event) {
    throw new NotFoundError('Slideshow');
  }

  const [{ count }] = await slideshowPhotosQuery(event.id).count('* as count');

  res.json({
    ...(await slideshowSettings(event)),
    photo_count: parseInt(count, 10) || 0,
    expires_at: event.expires_at || null
  });
}));

// Get all photos
router.get('/:slug/photos', verifyGalleryAccess, resolveGuest, async (req, res) => {
  try {
    // Get filter and sort parameters from query
    // `guest_id` is deliberately NOT read from the query string: the viewer's
    // own feedback is resolved from the request identity instead (see the
    // filter block). The frontend still sends it; it is ignored.
    const { filter, sort = 'upload_date', order = 'desc' } = req.query;

    // Get watermark settings to generate cache-busting version for URLs
    const watermarkSettings = await watermarkService.getWatermarkSettings();
    const wmVersion = watermarkSettings?.enabled
      ? `wm=${watermarkSettings.opacity}${watermarkSettings.position}${watermarkSettings.size}`
      : '';

    // Build the query with sorting
    const sortOrder = order === 'asc' ? 'asc' : 'desc';
    const isClient = req.accessLevel === 'client';
    let photosQuery = db('photos')
      .where('photos.event_id', req.event.id)
      // Guests/clients never see photos still being processed by the
      // background worker — the original is on disk but the thumbnail
      // / dimensions / EXIF haven't landed yet. Photos with a NULL
      // processing_status are pre-async-migration rows and are treated
      // as complete (the migration's column default is 'complete' so
      // this is just defensive against partial migration states).
      .where(function() {
        this.where('photos.processing_status', 'complete').orWhereNull('photos.processing_status');
      })
      .select('photos.*');

    // Guests only see visible photos; clients see all
    if (!isClient) {
      photosQuery = photosQuery.where(function() {
        this.where('photos.visibility', 'visible').orWhereNull('photos.visibility');
      });
    }

    // Apply sort option.
    //
    // Every branch carries photos.id as a tiebreaker (#1172). Without one the
    // order within a tie is whatever the engine happens to return, and ties are
    // the normal case rather than the exception: a bulk import writes hundreds
    // of rows inside the same second, so uploaded_at collapses — and with
    // captured_at NULL the COALESCE below collapses onto it too. The visible
    // symptom is a grid that reshuffles between page loads. id is insertion
    // order, so it also makes the fallback ordering meaningful rather than
    // arbitrary.
    if (sort === 'capture_date') {
      // Sort by capture date, falling back to uploaded_at if capture date is null.
      //
      // On SQLite that fallback cannot be a plain COALESCE, because the two
      // columns do not hold one type. photos.captured_at ends up carrying three
      // different storage classes:
      //
      //   integer  managed uploads — photoProcessor.js:441 writes a Date, which
      //            the sqlite3 binding stores as epoch milliseconds
      //   text     external imports and the backfill, which write ISO-8601
      //            ('2026-06-03T01:15:00.000Z') per the CLAUDE.md rule that
      //            Dates must not be handed to the binding in tests
      //   null     no capture date, so the sort falls through to uploaded_at —
      //            usually text in knex's 'YYYY-MM-DD HH:MM:SS' default shape,
      //            but epoch milliseconds on rows a .picpeak restore carried in
      //            from an install that stored them that way, so that column
      //            needs the same two branches
      //
      // SQLite orders INTEGER before TEXT unconditionally, so every managed
      // photo carrying EXIF sorted ahead of every photo that did not, whatever
      // the actual dates — a 2027 capture landing before a 2020 one. Among the
      // text values the 'T' separator (0x54) also outranks the space (0x20), so
      // a same-day ISO 01:15 sorted after a fallback 23:00.
      //
      // Normalising in the ORDER BY rather than rewriting the column: the data
      // fix would have to touch every existing row and every writer, which is a
      // much heavier change than the sort it is meant to correct. The cost here
      // is that this sort stops using idx_photos_captured_at on SQLite — an
      // acceptable trade on the fallback engine, where the alternative is an
      // index-assisted wrong answer.
      //
      // Postgres is untouched: captured_at is a real timestamp there, so
      // COALESCE already compares correctly.
      if (db.client.config.client === 'pg') {
        photosQuery = photosQuery
          .orderByRaw('COALESCE(photos.captured_at, photos.uploaded_at) ' + sortOrder);
      } else {
        photosQuery = photosQuery.orderByRaw(`CASE
            WHEN typeof(photos.captured_at) IN ('integer', 'real') THEN datetime(photos.captured_at / 1000, 'unixepoch')
            WHEN photos.captured_at IS NOT NULL THEN replace(replace(substr(photos.captured_at, 1, 19), 'T', ' '), 'Z', '')
            WHEN typeof(photos.uploaded_at) IN ('integer', 'real') THEN datetime(photos.uploaded_at / 1000, 'unixepoch')
            ELSE substr(photos.uploaded_at, 1, 19)
          END ${sortOrder}`);
      }
      photosQuery = photosQuery.orderBy('photos.id', sortOrder);
    } else if (sort === 'filename') {
      photosQuery = photosQuery.orderBy('photos.filename', sortOrder).orderBy('photos.id', sortOrder);
    } else {
      // Default: sort by upload date
      photosQuery = photosQuery.orderBy('photos.uploaded_at', sortOrder).orderBy('photos.id', sortOrder);
    }

    // Execute the query
    let photos = await photosQuery;
    
    // Check if feedback should be visible to guests. Read BEFORE the filter
    // block, not after: the filters below consult it, because a filter that
    // selects on other people's feedback is a way of reading that feedback.
    const feedbackService = require('../services/feedbackService');
    const feedbackSettings = await feedbackService.getEventFeedbackSettings(req.event.id);
    const showFeedbackToGuests = isClient || parseBooleanInput(feedbackSettings.show_feedback_to_guests, true);

    // Apply filtering if requested (supports global stats + per-guest interactions)
    if (filter) {
      const filterTokens = new Set(
        String(filter)
          .toLowerCase()
          .split(',')
          .map(token => token.trim())
          .filter(Boolean)
      );

      if (filterTokens.size > 0) {
        // Treat "saved" / "favorite" synonyms as favorites
        if (filterTokens.has('saved')) {
          filterTokens.add('favorited');
        }
        if (filterTokens.has('favorite')) {
          filterTokens.add('favorited');
        }

        const include = new Set();

        const includeBy = (predicate) => {
          photos.forEach(photo => {
            if (predicate(photo)) {
              include.add(photo.id);
            }
          });
        };

        // Whose feedback counts as "mine" for these filters.
        //
        // Resolved from the REQUEST, the same either/or the per-viewer is_liked
        // query below uses — never from the `guest_id` query parameter. Two
        // reasons, and both matter now that this is the only half left when
        // feedback is hidden:
        //
        //  - It never matched. The frontend's `gallery_guest_id` is a
        //    localStorage string it invents (`guest_<ts>_<rand>`) and never
        //    sends when submitting feedback; submissions store
        //    generateGuestIdentifier(req). So this lookup found nothing, and
        //    the filters only ever worked through the aggregate half — which
        //    is exactly the half now gated.
        //  - It is caller-controlled. Accepting an identifier from the query
        //    string would let anyone holding someone else's read their hidden
        //    memberships one token at a time, straight back through the gate.
        //
        // Hidden rows are excluded, matching what the viewer can actually SEE:
        // getPhotoFeedback drops is_hidden for the guest's own feedback too.
        // Unapproved rows are NOT excluded — a comment still in the moderation
        // queue is still the viewer's own, and that same read keeps it.
        let guestFeedbackByType = null;
        {
          const viewerFeedback = db('photo_feedback')
            .where({ event_id: req.event.id, is_hidden: false });
          if (req.guest?.id) {
            viewerFeedback.where('guest_id', req.guest.id);
          } else {
            viewerFeedback.where('guest_identifier', generateGuestIdentifier(req));
          }
          const guestFeedbackRows = await viewerFeedback
            .select('photo_id', 'feedback_type');

          guestFeedbackByType = guestFeedbackRows.reduce((acc, row) => {
            if (!acc[row.feedback_type]) {
              acc[row.feedback_type] = new Set();
            }
            acc[row.feedback_type].add(row.photo_id);
            return acc;
          }, {});
        }

        const includeGuestMatches = (type) => {
          const ids = guestFeedbackByType?.[type];
          if (ids && ids.size > 0) {
            ids.forEach(id => include.add(id));
          }
        };

        // Every token below is an OR of two halves: what THIS viewer marked,
        // and what ANYONE marked. The second half is other people's feedback,
        // so it is gated on show_feedback_to_guests exactly like the counts
        // this endpoint returns.
        //
        // Without the gate the setting only hides the numbers. A guest could
        // still send `?filter=liked` and get back precisely the set of photos
        // other people liked — the membership, one token at a time, which is
        // most of what the counts would have told them. The viewer's own half
        // is always theirs to filter by.
        const includeAggregate = (predicate) => {
          if (showFeedbackToGuests) includeBy(predicate);
        };

        if (filterTokens.has('liked')) {
          includeGuestMatches('like');
          includeAggregate(photo => (photo.like_count || 0) > 0);
        }

        if (filterTokens.has('favorited')) {
          includeGuestMatches('favorite');
          includeAggregate(photo => (photo.favorite_count || 0) > 0);
        }

        if (filterTokens.has('rated')) {
          includeGuestMatches('rating');
          includeAggregate(photo => (photo.average_rating || 0) > 0);
        }

        if (filterTokens.has('commented')) {
          includeGuestMatches('comment');
          if (showFeedbackToGuests) {
            const commentedRows = await db('photo_feedback')
              .where({ event_id: req.event.id, feedback_type: 'comment', is_approved: true, is_hidden: false })
              .groupBy('photo_id')
              .select('photo_id');
            commentedRows.forEach(row => include.add(row.photo_id));
          }
        }

        photos = photos.filter(photo => include.has(photo.id));
      }
    }
    
    // Then get comment counts separately
    const commentCounts = await db('photo_feedback')
      .whereIn('photo_id', photos.map(p => p.id))
      .where('feedback_type', 'comment')
      .where('is_approved', true)
      .where('is_hidden', false)
      .groupBy('photo_id')
      .select('photo_id', db.raw('COUNT(*) as comment_count'));
    
    // Create a map for quick lookup
    const commentMap = {};
    commentCounts.forEach(c => {
      commentMap[c.photo_id] = parseInt(c.comment_count);
    });

    // Per-viewer "is_liked" set (#590 follow-up). Hard refresh on the
    // gallery grid used to reset every heart to empty because the lifted
    // likedPhotoIds state started as a fresh Set on mount — even photos
    // the viewer had actually liked. Surface a per-viewer flag so the
    // frontend can seed correctly. Prefers req.guest.id when a verified
    // guest token is present (per-person identity), falls back to the
    // IP+UA hash that the original like was recorded under — same model
    // the /my-feedback endpoint uses. Skipped when feedback is hidden
    // from guests.
    const likedPhotoIds = new Set();
    if (showFeedbackToGuests && photos.length > 0) {
      const likeQuery = db('photo_feedback')
        // Hidden rows are not there, for the viewer's OWN feedback as much as
        // anyone's (#1150). getPhotoFeedback drops them and
        // updatePhotoFeedbackStats does not count them — leaving the heart
        // filled was the one place that disagreed, so a like the photographer
        // had hidden still showed as liked on a photo whose like_count was 0.
        .where({ event_id: req.event.id, feedback_type: 'like', is_hidden: false })
        .whereIn('photo_id', photos.map(p => p.id));
      if (req.guest?.id) {
        likeQuery.where('guest_id', req.guest.id);
      } else {
        likeQuery.where('guest_identifier', generateGuestIdentifier(req));
      }
      const likedRows = await likeQuery.select('photo_id');
      likedRows.forEach(row => likedPhotoIds.add(row.photo_id));
    }
    
    // Get actual categories used by photos in this event
    // This includes both global categories and event-specific ones
    const usedCategoryIds = await db('photos')
      .where('event_id', req.event.id)
      .whereNotNull('category_id')
      .distinct('category_id')
      .pluck('category_id');

    // Fetch category details from photo_categories table
    let categories = [];
    if (usedCategoryIds.length > 0) {
      const categoryDetails = await db('photo_categories')
        .whereIn('id', usedCategoryIds)
        .select('id', 'name', 'slug', 'is_global', 'hero_photo_id', 'allow_downloads')
        .orderBy('name', 'asc');

      categories = categoryDetails.map(cat => ({
        id: cat.id,
        name: cat.name,
        slug: cat.slug,
        is_global: cat.is_global,
        hero_photo_id: cat.hero_photo_id || null,
        // Per-category download flag (#640). false explicitly disables; the
        // gallery hides the download button. Defaults true so categories
        // created before migration 135 keep working.
        allow_downloads: parseBooleanInput(cat.allow_downloads, true)
      }));
    }

    // Build a map for quick category lookup
    const categoryMap = {};
    categories.forEach(cat => {
      categoryMap[cat.id] = cat;
    });
    
    // Log view — but NOT for the Live Slideshow kiosk. A running projector
    // refetches this list on every new-upload poll, which would massively
    // inflate total_views / unique_visitors. The slideshow is explicitly
    // excluded from real visitor analytics (migration 138 design).
    if (req.accessLevel !== 'slideshow') {
      await db('access_logs').insert({
        event_id: req.event.id,
        ip_address: req.ip,
        user_agent: req.headers['user-agent'],
        action: 'view'
      });
    }
    
    // Include protection settings in response
    const protectionSettings = {
      protection_level: req.event.protection_level || 'standard',
      image_quality: req.event.image_quality || 85,
      use_canvas_rendering: parseBooleanInput(req.event.use_canvas_rendering, false),
      fragmentation_level: req.event.fragmentation_level || 3,
      overlay_protection: parseBooleanInput(req.event.overlay_protection, true)
    };

    // Lightbox preview tier (#492). When the admin opts in, the
    // photos response carries a preview_url alongside url/thumbnail_url
    // — the lightbox uses preview_url when present and falls back to
    // url when not, so existing galleries continue working before
    // any preview has actually been generated.
    let lightboxPreviewEnabled = false;
    try {
      const setting = await db('app_settings')
        .where('setting_key', 'lightbox_preview_enabled')
        .first();
      if (setting) {
        const raw = setting.setting_value;
        // setting_value is JSON-stringified per migration 104; tolerate
        // raw boolean/string for forward-compat.
        const parsed = typeof raw === 'string' ? (() => {
          try { return JSON.parse(raw); } catch { return raw; }
        })() : raw;
        lightboxPreviewEnabled = parsed === true || parsed === 'true' || parsed === 1;
      }
    } catch (e) {
      // Setting missing / DB blip → fall back to off so the lightbox
      // keeps working with the original. logger.debug to avoid noise.
      logger.debug('lightbox_preview_enabled lookup failed, treating as off', { error: e?.message });
    }

    // #508: when the admin has flipped the "use original camera filenames"
    // toggle (#493), the lightbox surfaces each photo's original_filename
    // alongside the position counter so the photographer can map a guest's
    // selection back to source files. Tied to the same toggle as downloads —
    // one switch controls both surfaces.
    const useOriginalFilenames = await getUseOriginalFilenames();
    const globalHeroLogoVisible = await getAppSetting('branding_logo_display_hero', true);
    const globalLogoSize = await getAppSetting('branding_logo_size', 'medium');

    res.json({
      event: {
        id: req.event.id,
        event_name: req.event.event_name,
        event_type: req.event.event_type,
        event_date: req.event.event_date,
        welcome_message: req.event.welcome_message,
        color_theme: req.event.color_theme,
        expires_at: req.event.expires_at,
        hero_photo_id: req.event.hero_photo_id,
        // Defaults match /info: downloads on unless explicitly disabled,
        // uploads off unless explicitly enabled (#1028).
        allow_downloads: parseBooleanInput(req.event.allow_downloads, true),
        allow_user_uploads: parseBooleanInput(req.event.allow_user_uploads, false),
        disable_right_click: parseBooleanInput(req.event.disable_right_click, false),
        watermark_downloads: parseBooleanInput(req.event.watermark_downloads, false),
        watermark_text: req.event.watermark_text,
        enable_devtools_protection: parseBooleanInput(req.event.enable_devtools_protection, false),
        use_canvas_rendering: parseBooleanInput(req.event.use_canvas_rendering, false),
        hero_logo_visible: resolveHeroLogoVisible(req.event.hero_logo_visible, globalHeroLogoVisible),
        hero_logo_size: req.event.hero_logo_size || globalLogoSize || 'medium',
        hero_logo_position: req.event.hero_logo_position || 'top',
        hero_logo_url: req.event.hero_logo_url || null,
        header_style: req.event.header_style || 'standard',
        hero_divider_style: req.event.hero_divider_style || 'wave',
        hero_image_anchor: req.event.hero_image_anchor || 'center',
        default_photo_sort: req.event.default_photo_sort || 'upload_date_desc',
        download_zip_ready: !!(req.event.download_zip_path && req.event.download_zip_generated_at),
        // Mirror of the admin-side toggle so the lightbox can decide
        // whether to surface original camera filenames (#508).
        use_original_filenames: useOriginalFilenames,
        ...protectionSettings
      },
      categories: categories,
      photos: photos.map(photo => {
        const useJwtUrl = (protectionSettings.protection_level === 'basic' || protectionSettings.protection_level === 'standard');
        // Add watermark version to URLs for cache busting when settings change
        const wmQuery = wmVersion ? `?${wmVersion}` : '';
        const photoUrl = useJwtUrl ?
          `/api/gallery/${req.params.slug}/photo/${photo.id}${wmQuery}` :
          `/api/secure-images/${req.params.slug}/secure/${photo.id}/{{token}}`;

        return {
          id: photo.id,
          filename: photo.filename,
          // Raw camera filename (or null for pre-migration-062 uploads).
          // The lightbox renders it when `use_original_filenames` is on.
          original_filename: photo.original_filename || null,
          url: photoUrl,
          thumbnail_url: photo.thumbnail_path ? `/api/gallery/${req.params.slug}/thumbnail/${photo.id}${wmQuery}` : null,
          // Hero-optimized image URL (1920x1080) for full-width hero sections
          hero_url: `/api/gallery/${req.params.slug}/hero/${photo.id}${wmQuery}`,
          // Lightbox preview URL (#492). Only emitted when the admin
          // has flipped lightbox_preview_enabled — the frontend
          // lightbox reads preview_url with a fallback to url so
          // installs that haven't opted in keep loading the original
          // (current behaviour). Skipped for videos since they don't
          // get a preview tier; lightbox will use the original .url.
          preview_url: lightboxPreviewEnabled
            && photo.media_type !== 'video'
            && (!photo.mime_type || !photo.mime_type.startsWith('video/'))
            ? `/api/gallery/${req.params.slug}/preview/${photo.id}${wmQuery}`
            : null,
          // Slideshow source (#1015). Same preview tier, but emitted
          // unconditionally: the slideshow has no `url` fallback worth
          // taking (originals are projector-sized) and must never land on
          // `hero_url`, which is cover-cropped to 16:9 — that made the
          // "no crop" fit letterbox an already-cropped frame. The preview
          // route generates lazily and redirects to the original on any
          // failure, so this is safe even where no preview exists yet.
          slideshow_url: photo.media_type !== 'video'
            && (!photo.mime_type || !photo.mime_type.startsWith('video/'))
            ? `/api/gallery/${req.params.slug}/preview/${photo.id}${wmQuery}`
            : null,
          secure_url_template: `/api/secure-images/${req.params.slug}/secure/${photo.id}/{{token}}`,
          download_url_template: `/api/secure-images/${req.params.slug}/secure-download/${photo.id}/{{token}}`,
          type: photo.type,
          category_id: photo.category_id || null,
          category_name: photo.category_id && categoryMap[photo.category_id] ? categoryMap[photo.category_id].name : null,
          // Per-category download permission (#640). Defaults true for photos
          // without a category or for categories that pre-date migration 135.
          category_allow_downloads: photo.category_id && categoryMap[photo.category_id]
            ? parseBooleanInput(categoryMap[photo.category_id].allow_downloads, true)
            : true,
          category_slug: photo.category_id && categoryMap[photo.category_id] ? categoryMap[photo.category_id].slug : null,
          size: photo.size_bytes,
          uploaded_at: photo.uploaded_at,
          // Image dimensions for layout calculations
          width: photo.width || null,
          height: photo.height || null,
          // Fixed: Use the calculated useJwtUrl variable instead of recalculating
          requires_token: !useJwtUrl,
          // EXIF capture date
          captured_at: photo.captured_at || null,
          // Media type
          media_type: photo.media_type || null,
          mime_type: photo.mime_type || null,
          duration: photo.duration || null,
          // Feedback data (hidden when show_feedback_to_guests is disabled)
          has_feedback: showFeedbackToGuests ? (commentMap[photo.id] > 0 || photo.average_rating > 0 || photo.like_count > 0) : false,
          average_rating: showFeedbackToGuests ? (photo.average_rating || 0) : 0,
          comment_count: showFeedbackToGuests ? (commentMap[photo.id] || 0) : 0,
          like_count: showFeedbackToGuests ? (photo.like_count || 0) : 0,
          // Per-viewer flag (#590 follow-up) — true when this viewer has
          // an active like row for this photo, false otherwise. Lets the
          // grid seed its lifted likedPhotoIds correctly on hard refresh.
          is_liked: showFeedbackToGuests ? likedPhotoIds.has(photo.id) : false,
          favorite_count: showFeedbackToGuests ? (photo.favorite_count || 0) : 0,
          // Visibility (only included for clients)
          ...(isClient ? { visibility: photo.visibility || 'visible' } : {})
        };
      })
    });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to fetch photos');
  }
});

// Toggle photo visibility (client-only)
router.patch('/:slug/photos/:photoId/visibility', verifyGalleryAccess, async (req, res) => {
  try {
    if (req.accessLevel !== 'client') {
      return res.status(403).json({ error: 'Client access required' });
    }

    const { photoId } = req.params;
    const { visibility } = req.body;

    if (!['visible', 'hidden'].includes(visibility)) {
      return res.status(400).json({ error: 'Invalid visibility value' });
    }

    const photo = await db('photos')
      .where({ id: photoId, event_id: req.event.id })
      .first();

    if (!photo) {
      return res.status(404).json({ error: 'Photo not found' });
    }

    await db('photos')
      .where({ id: photoId, event_id: req.event.id })
      .update({ visibility });

    // A client hiding/showing a photo changes the guest download bundle —
    // drop the cached ZIP so it rebuilds fresh (codex review).
    downloadZipService.invalidate(req.event.id);

    res.json({ message: 'Photo visibility updated', visibility });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to update photo visibility');
  }
});

// Bulk toggle photo visibility (client-only)
router.patch('/:slug/photos/visibility/bulk', verifyGalleryAccess, async (req, res) => {
  try {
    if (req.accessLevel !== 'client') {
      return res.status(403).json({ error: 'Client access required' });
    }

    const { photoIds, visibility } = req.body;

    if (!Array.isArray(photoIds) || photoIds.length === 0) {
      return res.status(400).json({ error: 'Invalid photo IDs' });
    }

    if (!['visible', 'hidden'].includes(visibility)) {
      return res.status(400).json({ error: 'Invalid visibility value' });
    }

    const count = await db('photos')
      .whereIn('id', photoIds)
      .where('event_id', req.event.id)
      .update({ visibility });

    // Client bulk hide/show alters the guest download bundle — invalidate
    // the cached ZIP (codex review).
    downloadZipService.invalidate(req.event.id);

    res.json({ message: `${count} photos updated`, visibility });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to update photo visibility');
  }
});

// Download single photo
router.get('/:slug/download/:photoId', verifyGalleryAccess, denySlideshowToken, async (req, res) => {
  try {
    const { photoId } = req.params;

    // Check if downloads are allowed for this event
    if (!parseBooleanInput(req.event.allow_downloads, true)) {
      return res.status(403).json({ error: 'Downloads are disabled for this gallery' });
    }

    const photo = await db('photos')
      .where({ id: photoId, event_id: req.event.id })
      .first();

    if (!photo) {
      return res.status(404).json({ error: 'Photo not found' });
    }

    // Block guest access to hidden photos
    if (photo.visibility === 'hidden' && req.accessLevel !== 'client') {
      return res.status(403).json({ error: 'Photo not available' });
    }

    // Per-category download permission (#640). Photos without a category are
    // always downloadable when the event allows downloads — only categorised
    // photos can opt out per-category.
    if (photo.category_id) {
      const cat = await db('photo_categories')
        .where('id', photo.category_id)
        .first('allow_downloads');
      if (cat && !parseBooleanInput(cat.allow_downloads, true)) {
        return res.status(403).json({ error: 'Downloads are disabled for this category' });
      }
    }

    // Update download count
    await db('photos').where('id', photoId).increment('download_count', 1);
    
    // Log download
    await db('access_logs').insert({
      event_id: req.event.id,
      ip_address: req.ip,
      user_agent: req.headers['user-agent'],
      action: 'download',
      photo_id: photoId
    });
    
    // Where the bytes actually live. Managed photos sit behind the storage
    // abstraction and on an S3/R2 deployment are not on local disk at all —
    // resolving a filesystem path unconditionally here is what made every
    // single-photo download fail in S3 mode, while download-all and
    // secure-images worked because they already went through getStorage().
    //
    // resolvePhotoStorageKey returns null for external/reference photos: those
    // live on a local mount and keep the filesystem path.
    let storageKey = null;
    try {
      storageKey = resolvePhotoStorageKey(req.event, photo);
    } catch (resolveError) {
      logger.error('Failed to resolve photo storage key for download', {
        slug: req.params.slug,
        photoId,
        eventId: req.event.id,
        error: resolveError.message,
      });
      return res.status(404).json({ error: 'Photo file not found' });
    }

    // Get watermark settings - apply if global setting OR event-level setting is enabled
    const watermarkSettings = await watermarkService.getWatermarkSettings();
    const eventWatermarkEnabled = req.event.watermark_downloads === true || req.event.watermark_downloads === 1;
    const shouldApplyWatermark = (watermarkSettings && watermarkSettings.enabled) || eventWatermarkEnabled;

    // #493: if the admin enabled "use original filenames", surface the
    // pre-rename camera filename in Content-Disposition. Storage path is
    // unchanged — only the user-visible download name is swapped.
    const useOriginal = await getUseOriginalFilenames();
    const downloadName = pickRawDownloadName(photo, useOriginal);
    const contentDisposition = buildContentDisposition(downloadName);

    if (shouldApplyWatermark) {
      // Apply watermark and send
      // Use event watermark text if available, otherwise fall back to global settings
      const effectiveSettings = {
        ...watermarkSettings,
        enabled: true,
        text: req.event.watermark_text || watermarkSettings?.text || 'Protected'
      };

      // applyWatermark takes a PATH, and caches on it — buffer inputs skip the
      // cache deliberately. In S3 mode materialize a tmp local copy and hand
      // it the copy's path, exactly as the zip builders below do, so the cache
      // still applies and the full-size original isn't re-processed per
      // download.
      let watermarkedBuffer;
      try {
        watermarkedBuffer = storageKey
          ? await withLocalCopy(storageKey, (localPath) =>
            watermarkService.applyWatermark(localPath, effectiveSettings))
          : await watermarkService.applyWatermark(
            resolvePhotoFilePath(req.event, photo), effectiveSettings);
      } catch (watermarkError) {
        // Classify, the same way the pass-through branch below does. This can
        // fail because the source object is gone, but equally because
        // getToFile timed out, the tmp filesystem filled up, or sharp failed —
        // and reporting an operational failure as 404 tells the guest their
        // photo does not exist and tells us nothing.
        const gone = watermarkError.code === 'ENOENT'
          || watermarkError.name === 'NoSuchKey'
          || watermarkError.name === 'NotFound'
          || watermarkError.$metadata?.httpStatusCode === 404;
        logger.error('Failed to watermark photo for download', {
          slug: req.params.slug,
          photoId,
          eventId: req.event.id,
          error: watermarkError.message,
        });
        return gone
          ? res.status(404).json({ error: 'Photo file not found' })
          : res.status(500).json({ error: 'Failed to download photo' });
      }

      res.set({
        'Content-Type': photo.mime_type || 'image/jpeg',
        'Content-Disposition': contentDisposition,
        'Content-Length': watermarkedBuffer.length
      });

      return res.send(watermarkedBuffer);
    }

    const storage = getStorage();
    if (storageKey && storage.kind() !== 'local') {
      // Deliberately NOT the local path: res.sendFile emits Content-Length,
      // Accept-Ranges, ETag and Last-Modified and answers Range requests with
      // a 206, and a bare stream.pipe(res) has none of that. On local disk
      // sendFile stays the better implementation, so it stays the branch.
      //
      // On S3 the parts that matter for a download are reproduced: the length
      // (browsers need it for the progress indicator, which matters most on
      // exactly the large files this route serves) and Range, so an
      // interrupted download resumes instead of appending a second full body
      // onto the partial file.
      const stat = await storage.stat(storageKey);
      if (!stat) {
        logger.error('Photo not found in storage backend for download', {
          slug: req.params.slug,
          photoId,
          eventId: req.event.id,
          storageKey,
        });
        return res.status(404).json({ error: 'Photo file not found' });
      }

      const lastModified = stat.mtime ? new Date(stat.mtime).toUTCString() : null;
      const headers = {
        'Content-Type': photo.mime_type || 'image/jpeg',
        'Content-Disposition': contentDisposition,
        'Accept-Ranges': 'bytes',
      };
      if (lastModified) headers['Last-Modified'] = lastModified;

      // If-Range: a client resuming an interrupted download sends back the
      // validator it was given last time. If the object has been replaced
      // since — the watcher re-importing a swapped file, an admin re-upload —
      // answering 206 from the NEW bytes lets the client splice two different
      // versions into one corrupt file. A validator that doesn't match means
      // a full 200, which is the whole point of the header.
      const ifRange = req.headers['if-range'];
      const staleValidator = !!ifRange && (!lastModified || ifRange.trim() !== lastModified);
      const range = staleValidator ? null : parseByteRange(req.headers.range, stat.size);

      // Express routes HEAD through this GET handler, and Node then discards
      // the body — but the pipe still drains the whole object out of S3
      // first, so a metadata probe from a download manager costs a full
      // transfer in egress and latency. Everything a HEAD needs is already in
      // `stat`.
      if (req.method === 'HEAD') {
        res.set({ ...headers, 'Content-Length': stat.size });
        return res.end();
      }

      // Open the stream BEFORE any header is staged or sent. stat() succeeding
      // does not mean get() will: a concurrent delete or replace, or a
      // transient backend error, lands here. Once writeHead(206) has gone out
      // the outer catch can do nothing but throw ERR_HTTP_HEADERS_SENT, and in
      // the non-range case it would send its 500 JSON underneath the staged
      // image/jpeg attachment headers — a .jpg file full of JSON.
      let stream;
      try {
        stream = range
          ? await storage.getRange(storageKey, range.start, range.end)
          : await storage.get(storageKey);
      } catch (fetchError) {
        const gone = fetchError.code === 'ENOENT'
          || fetchError.name === 'NoSuchKey'
          || fetchError.name === 'NotFound'
          || fetchError.$metadata?.httpStatusCode === 404;
        logger.error('Failed to open photo stream for download', {
          slug: req.params.slug,
          photoId,
          eventId: req.event.id,
          storageKey,
          error: fetchError.message,
        });
        return gone
          ? res.status(404).json({ error: 'Photo file not found' })
          : res.status(500).json({ error: 'Failed to download photo' });
      }

      if (range) {
        // status()+set() rather than writeHead(): writeHead commits the
        // response immediately, so a stream that resolves and THEN errors
        // before its first chunk would leave pipeStreamToResponse able only to
        // destroy the connection. Staged headers are flushed by the first body
        // write, which means an error at byte zero can still clear them and
        // return a clean, retryable status instead of a transport reset.
        res.status(206).set({
          ...headers,
          'Content-Range': `bytes ${range.start}-${range.end}/${stat.size}`,
          'Content-Length': (range.end - range.start) + 1,
        });
      } else {
        res.set({ ...headers, 'Content-Length': stat.size });
      }
      pipeStreamToResponse(stream, res, {
        context: range ? `download range for photo ${photo.id}` : `download for photo ${photo.id}`,
      });
      return;
    }

    let filePath;
    try {
      filePath = resolvePhotoFilePath(req.event, photo);
    } catch (resolveError) {
      logger.error('Failed to resolve photo path for download', {
        slug: req.params.slug,
        photoId,
        eventId: req.event.id,
        error: resolveError.message,
      });
      return res.status(404).json({ error: 'Photo file not found' });
    }

    // res.download() builds Content-Disposition itself but doesn't emit the
    // RFC 5987 filename* parameter, so unicode camera filenames would lose
    // their bytes on download. Set the header explicitly and stream the
    // file with res.sendFile-equivalent semantics.
    res.set({
      'Content-Type': photo.mime_type || 'image/jpeg',
      'Content-Disposition': contentDisposition,
    });
    res.sendFile(filePath, (downloadError) => {
      if (downloadError) {
        logger.error('Error streaming gallery download', {
          slug: req.params.slug,
          photoId,
          eventId: req.event.id,
          error: downloadError.message,
        });
      }
    });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to download photo');
  }
});

// Download all photos as ZIP
// Zip downloads count toward each contained photo's download_count (#895)
// — previously only single-photo downloads did, so galleries whose guests
// grab the zip showed 0 per-photo downloads forever. Used by the
// pre-generated-zip branches only: it mirrors downloadZipService._build,
// which zips EVERY event photo with no per-category allow_downloads
// filter — the counter has to reflect what actually shipped. (That the
// prebuilt zip ignores per-category download opt-outs is a separate,
// pre-existing issue.) Known approximation: _build skips entries whose
// WATERMARK step fails and still publishes the zip; counting those
// would need a persisted archive manifest, which isn't worth it for
// that tail case. Fire-and-forget at the call sites: counters must
// never fail a download.
async function bumpEventDownloadCounts(eventId) {
  await db('photos').where('event_id', eventId).increment('download_count', 1);
}

router.get('/:slug/download-all', verifyGalleryAccess, denySlideshowToken, async (req, res) => {
  try {
    // Check if downloads are allowed for this event
    if (!parseBooleanInput(req.event.allow_downloads, true)) {
      return res.status(403).json({ error: 'Downloads are disabled for this gallery' });
    }

    // Try to serve pre-generated zip (instant download with Content-Length).
    // Guests may use the prebuilt cache ONLY when the event has no hidden
    // photos: a cache built before a photo was hidden — or before this
    // visibility-aware builder shipped — could otherwise still leak it, and
    // getZipInfo only checks the DB pointer + file stat, not freshness. When
    // hidden photos exist, guests fall through to the visibility-filtered
    // stream below. PIN-clients always stream a full archive.
    const isClient = canSeeHiddenPhotos(req.accessLevel);
    const eventHasHidden = await db('photos')
      .where({ event_id: req.event.id, visibility: 'hidden' })
      .first()
      .then(Boolean);
    const zipInfo = (isClient || eventHasHidden)
      ? null
      : await downloadZipService.getZipInfo(req.event.id);
    if (zipInfo) {
      const storage = getStorage();

      // Per-event presigned-URL fast path (#328 follow-up). Conditions:
      //   1. STORAGE_BACKEND=s3 (presigned URLs are S3-only)
      //   2. event.allow_presigned_download is true (admin opted in)
      //   3. Watermarking is OFF for this event — presigned URLs bypass the
      //      backend, which means no watermark on bytes leaving S3.
      // Falls through to streaming on any condition mismatch.
      const wantsPresigned = req.event.allow_presigned_download === true || req.event.allow_presigned_download === 1;
      const watermarkOnEvent = req.event.watermark_downloads === true || req.event.watermark_downloads === 1;
      if (wantsPresigned && storage.kind() === 's3' && !watermarkOnEvent) {
        try {
          const url = await storage.signedUrl(zipInfo.key, 300); // 5 min
          db('access_logs').insert({
            event_id: req.event.id,
            ip_address: req.ip,
            user_agent: req.headers['user-agent'],
            action: 'download_all_presigned'
          }).catch(() => {});
          bumpEventDownloadCounts(req.event.id).catch(() => {});
          res.redirect(302, url);
          return;
        } catch (err) {
          logger.warn('presigned download-all failed, falling back to stream', {
            eventId: req.event.id,
            error: err.message,
          });
        }
      }

      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Length', zipInfo.size);
      res.setHeader('Content-Disposition', `attachment; filename="${req.event.slug}.zip"`);
      const stream = await storage.get(zipInfo.key);
      pipeStreamToResponse(stream, res, { context: `prepared zip for event ${req.event.id}`, missingStatus: 410 });

      // Log bulk download
      db('access_logs').insert({
        event_id: req.event.id,
        ip_address: req.ip,
        user_agent: req.headers['user-agent'],
        action: 'download_all'
      }).catch(() => {});
      bumpEventDownloadCounts(req.event.id).catch(() => {});
      return;
    }

    // Fallback: on-the-fly streaming (existing behavior). Only pre-build the
    // guest cache when it will actually be served next time — a guest
    // download of an event with no hidden photos. Client bypasses and
    // hidden-photo events always stream, so rebuilding the guest archive on
    // those requests is wasted I/O (codex review).
    if (!isClient && !eventHasHidden) {
      downloadZipService.generateZip(req.event.id).catch(err =>
        logger.warn('Background zip generation failed', { eventId: req.event.id, error: err.message })
      );
    }

    // Fetch photos — exclude photos in categories that disabled downloads (#640).
    // Uncategorised photos are always included; categories without the column
    // (pre-migration-135) fall through the LEFT JOIN's null and are included.
    const photos = await applyPhotoVisibilityFilter(
      db('photos')
        .leftJoin('photo_categories', 'photos.category_id', 'photo_categories.id')
        .where('photos.event_id', req.event.id)
        .where(function () {
          this.whereNull('photos.category_id')
            .orWhere('photo_categories.allow_downloads', true)
            .orWhereNull('photo_categories.allow_downloads');
        }),
      req.accessLevel
    )
      .select('photos.*')
      .orderBy('photos.type', 'asc')
      .orderBy('photos.uploaded_at', 'desc');

    if (photos.length === 0) {
      return res.status(404).json({ error: 'No photos found' });
    }

    // Count unique types
    const uniqueTypes = new Set(photos.map(p => p.type)).size;
    const hasMultipleTypes = uniqueTypes > 1;

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${req.event.slug}.zip"`);

    const archive = archiver('zip', { zlib: { level: 5 } });
    archive.on('error', (err) => {
      throw err;
    });

    archive.pipe(res);

    // Get watermark settings - apply if global setting OR event-level setting is enabled
    const watermarkSettings = await watermarkService.getWatermarkSettings();
    const eventWatermarkEnabled = req.event.watermark_downloads === true || req.event.watermark_downloads === 1;
    const shouldApplyWatermark = (watermarkSettings && watermarkSettings.enabled) || eventWatermarkEnabled;
    const effectiveSettings = shouldApplyWatermark ? {
      ...watermarkSettings,
      enabled: true,
      text: req.event.watermark_text || watermarkSettings?.text || 'Protected'
    } : null;

    // Add photos to archive — managed photos via storage backend, external via local path.
    const { resolvePhotoStorageKey } = require('../services/photoResolver');
    const storage = getStorage();
    // #493: resolve a unique display filename per photo up-front so collisions
    // get a deterministic `_1` suffix before the entries hit the archive.
    const useOriginalBulk = await getUseOriginalFilenames();
    const bulkEntryNames = getZipEntryNames(photos, useOriginalBulk);
    // Only photos whose append succeeded count as downloaded (#895) — the
    // catch below deliberately skips missing/corrupt sources, and those
    // never make it into the archive.
    const appendedIds = [];
    for (let i = 0; i < photos.length; i += 1) {
      const photo = photos[i];
      const storageKey = resolvePhotoStorageKey(req.event, photo);
      const entryName = bulkEntryNames[i];
      let archiveName;
      if (hasMultipleTypes) {
        const folderName = photo.type === 'individual' ? 'Individual Photos' : 'Collages';
        archiveName = path.join(folderName, entryName);
      } else {
        archiveName = entryName;
      }

      try {
        // Verify the source exists BEFORE appending — but only for local
        // sources: fs.createReadStream is lazy, so its error fires outside
        // this try/catch and the archive 'error' handler then kills the
        // whole response instead of skipping one photo (#895 review). S3's
        // get() awaits GetObject and rejects right here on a missing key,
        // so a preflight HEAD per entry would just be a redundant serial
        // round trip (500-photo zip = 500 extra HEADs).
        if (storageKey && storage.kind() === 'local') {
          const srcStat = await storage.stat(storageKey);
          if (!srcStat) {
            throw new Error(`Photo missing in storage: ${storageKey}`);
          }
        } else if (!storageKey && !fs.existsSync(resolvePhotoFilePath(req.event, photo))) {
          throw new Error('Photo file missing on disk');
        }

        if (shouldApplyWatermark && effectiveSettings) {
          // Watermark service operates on a local path. For managed photos in
          // S3 mode, materialize a tmp local copy first.
          const { withLocalCopy } = require('../services/imageProcessor');
          const sourceForWatermark = storageKey
            ? null
            : resolvePhotoFilePath(req.event, photo);

          const watermarkedBuffer = storageKey
            ? await withLocalCopy(storageKey, (localPath) =>
              watermarkService.applyWatermark(localPath, effectiveSettings)
            )
            : await watermarkService.applyWatermark(sourceForWatermark, effectiveSettings);

          archive.append(watermarkedBuffer, { name: archiveName });
        } else if (storageKey) {
          const stream = await storage.get(storageKey);
          archive.append(stream, { name: archiveName });
        } else {
          archive.file(resolvePhotoFilePath(req.event, photo), { name: archiveName });
        }
        appendedIds.push(photo.id);
      } catch (err) {
        logger.warn('Skipping photo in bulk download due to error', {
          slug: req.params.slug,
          photoId: photo.id,
          eventId: req.event.id,
          error: err.message,
        });
      }
    }

    await archive.finalize();

    // Log bulk download
    await db('access_logs').insert({
      event_id: req.event.id,
      ip_address: req.ip,
      user_agent: req.headers['user-agent'],
      action: 'download_all'
    });
    // Exactly the photos that made it into this archive (#895) — skipped
    // (missing/corrupt) sources don't count.
    if (appendedIds.length > 0) {
      db('photos').whereIn('id', appendedIds)
        .increment('download_count', 1).catch(() => {});
    }
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to create download archive');
  }
});

// Download selected photos as ZIP
router.post('/:slug/download-selected', verifyGalleryAccess, denySlideshowToken, async (req, res) => {
  try {
    // Check if downloads are allowed for this event
    if (!parseBooleanInput(req.event.allow_downloads, true)) {
      return res.status(403).json({ error: 'Downloads are disabled for this gallery' });
    }

    const ids = Array.isArray(req.body?.photo_ids) ? req.body.photo_ids : [];
    if (!ids.length) {
      return res.status(400).json({ error: 'photo_ids is required (non-empty array)' });
    }

    // Clean IDs
    const photoIds = ids
      .map((v) => parseInt(v, 10))
      .filter((v) => Number.isInteger(v))
      .slice(0, 500);

    if (photoIds.length === 0) {
      return res.status(400).json({ error: 'No valid photo IDs provided' });
    }

    // Fetch photos — exclude photos in categories that disabled downloads (#640).
    // Same LEFT JOIN pattern as the download-all endpoint.
    const photos = await applyPhotoVisibilityFilter(
      db('photos')
        .leftJoin('photo_categories', 'photos.category_id', 'photo_categories.id')
        .where('photos.event_id', req.event.id)
        .whereIn('photos.id', photoIds)
        .where(function () {
          this.whereNull('photos.category_id')
            .orWhere('photo_categories.allow_downloads', true)
            .orWhereNull('photo_categories.allow_downloads');
        }),
      req.accessLevel
    )
      .select('photos.*')
      .orderBy('photos.uploaded_at', 'desc');

    if (photos.length === 0) {
      return res.status(404).json({ error: 'No photos found for selected IDs' });
    }

    const archiveName = `${req.event.slug}-selected.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${archiveName}"`);

    const archive = archiver('zip', { zlib: { level: 5 } });
    archive.on('error', (err) => {
      logger.error('Zip error generating selected download', {
        slug: req.params.slug,
        eventId: req.event?.id,
        error: err.message,
      });
      try {
        res.status(500).end();
      } catch (_) {
        // ignore double-send errors
      }
    });
    archive.pipe(res);

    // Check watermark settings - apply if global setting OR event-level setting is enabled
    const watermarkSettings = await watermarkService.getWatermarkSettings();
    const eventWatermarkEnabled = req.event.watermark_downloads === true || req.event.watermark_downloads === 1;
    const shouldApplyWatermark = (watermarkSettings && watermarkSettings.enabled) || eventWatermarkEnabled;
    const effectiveSettings = shouldApplyWatermark ? {
      ...watermarkSettings,
      enabled: true,
      text: req.event.watermark_text || watermarkSettings?.text || 'Protected'
    } : null;

    const { resolvePhotoStorageKey: resolveSelectedKey } = require('../services/photoResolver');
    const { withLocalCopy: withSelectedLocalCopy } = require('../services/imageProcessor');
    const selectedStorage = getStorage();
    // #493: same display-name resolution as bulk download, with dedup.
    const useOriginalSelected = await getUseOriginalFilenames();
    const selectedEntryNames = getZipEntryNames(photos, useOriginalSelected);
    // Only photos whose append succeeded count as downloaded (#895).
    const appendedIds = [];
    for (let i = 0; i < photos.length; i += 1) {
      const photo = photos[i];
      const name = selectedEntryNames[i] || `photo-${photo.id}.jpg`;
      const storageKey = resolveSelectedKey(req.event, photo);
      try {
        // Same pre-append source check as download-all (#895 review),
        // local backend only: a lazy fs stream's async error would kill
        // the response instead of skipping the photo; S3's get() rejects
        // at the await below, so no redundant per-entry HEAD there.
        if (storageKey && selectedStorage.kind() === 'local') {
          const srcStat = await selectedStorage.stat(storageKey);
          if (!srcStat) {
            throw new Error(`Photo missing in storage: ${storageKey}`);
          }
        } else if (!storageKey && !fs.existsSync(resolvePhotoFilePath(req.event, photo))) {
          throw new Error('Photo file missing on disk');
        }

        if (shouldApplyWatermark && effectiveSettings) {
          const buf = storageKey
            ? await withSelectedLocalCopy(storageKey, (lp) =>
              watermarkService.applyWatermark(lp, effectiveSettings)
            )
            : await watermarkService.applyWatermark(resolvePhotoFilePath(req.event, photo), effectiveSettings);
          archive.append(buf, { name });
        } else if (storageKey) {
          const stream = await selectedStorage.get(storageKey);
          archive.append(stream, { name });
        } else {
          archive.file(resolvePhotoFilePath(req.event, photo), { name });
        }
        appendedIds.push(photo.id);
      } catch (err) {
        logger.warn('Skipping selected photo due to error', {
          slug: req.params.slug,
          photoId: photo.id,
          eventId: req.event.id,
          error: err.message,
        });
      }
    }

    await archive.finalize();

    await db('access_logs').insert({
      event_id: req.event.id,
      ip_address: req.ip,
      user_agent: req.headers['user-agent'],
      action: 'download_selected'
    });
    // Exactly the photos that made it into this archive (#895) — skipped
    // (missing/corrupt) sources don't count.
    if (appendedIds.length > 0) {
      db('photos').whereIn('id', appendedIds)
        .increment('download_count', 1).catch(() => {});
    }
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to download selected photos');
  }
});


// Explicit per-photo view beacon (#895). Counting views on the image-
// serving routes is wrong in both directions: the lightbox preloads the
// prev/next neighbours (three fetches per open), while a preloaded
// neighbour that becomes the current slide is never re-fetched (#505
// keeps the DOM node alive across the swipe) — so request-level counters
// overcount preloads AND undercount swipe-throughs. Instead the lightbox
// pings this endpoint exactly when a photo becomes the visible slide.
// This also covers enhanced/maximum-protection galleries, whose bytes
// are served by /api/secure-images and never pass the routes below.
// The slideshow kiosk is excluded (denySlideshowToken; migration 138).
router.post('/:slug/photo/:photoId/view',
  verifyGalleryAccess,
  denySlideshowToken,
  async (req, res) => {
    try {
      const photo = await db('photos')
        .where({ id: req.params.photoId, event_id: req.event.id })
        .first('id', 'visibility');
      if (!photo) {
        return res.status(404).json({ error: 'Photo not found' });
      }
      if (photo.visibility === 'hidden' && req.accessLevel !== 'client') {
        return res.status(403).json({ error: 'Photo not available' });
      }
      await db('photos').where('id', photo.id).increment('view_count', 1);
      res.status(204).end();
    } catch (error) {
      errorResponse(res, error, 500, 'Failed to record view');
    }
  });

// View single photo (with watermark if enabled)
router.get('/:slug/photo/:photoId',
  verifyGalleryAccess,
  async (req, res) => {
    try {
      const { photoId } = req.params;

      const photo = await db('photos')
        .where({ id: photoId, event_id: req.event.id })
        .first();

      if (!photo) {
        return res.status(404).json({ error: 'Photo not found' });
      }

      // Block guest access to hidden photos
      if (photo.visibility === 'hidden' && req.accessLevel !== 'client') {
        return res.status(403).json({ error: 'Photo not available' });
      }

      // Check if this is a video
      const isVideo = photo.media_type === 'video' || (photo.mime_type && photo.mime_type.startsWith('video/'));

      // Check protection level - basic and standard protection allow direct JWT access
      const protectionLevel = req.event.protection_level || 'standard';

      if (protectionLevel === 'enhanced' || protectionLevel === 'maximum') {
        // For enhanced/maximum protection, redirect to secure endpoint
        return res.status(302).json({
          error: 'Secure access required',
          secureEndpoint: `/api/secure-images/${req.params.slug}/generate-token`,
          photoId: photoId
        });
      }

      // Resolve where to read the photo bytes from. For external/reference
      // photos the source is always a local mount path. For managed photos
      // we go through the storage abstraction so S3 deployments work too
      // (#432 — previously this route did fs.* directly and 500'd in S3
      // mode because the file wasn't on the container's local fs).
      const { resolvePhotoStorageKey, resolvePhotoFilePath } = require('../services/photoResolver');
      const storage = getStorage();
      const isExternal = photo.source_origin === 'external' || photo.source_origin === 'reference';
      const useStorageBackend = !isExternal;

      let filePath = null;     // Local fs path (external photos OR LocalFs storage)
      let storageKey = null;   // Relative storage key (managed photos via storage abstraction)
      let stat;
      let fileSize;

      if (useStorageBackend) {
        try {
          storageKey = resolvePhotoStorageKey(req.event, photo);
        } catch (resolveError) {
          logger.error('Failed to resolve photo storage key', {
            slug: req.params.slug,
            photoId,
            eventId: req.event.id,
            error: resolveError.message,
            photoPath: photo.path,
            photoFilename: photo.filename
          });
          return res.status(404).json({ error: 'Photo file not found' });
        }
        stat = await storage.stat(storageKey);
        if (!stat) {
          logger.error('Photo not found in storage backend', {
            slug: req.params.slug,
            photoId,
            eventId: req.event.id,
            storageKey
          });
          return res.status(404).json({ error: 'Photo file not found' });
        }
        fileSize = stat.size;
      } else {
        try {
          filePath = resolvePhotoFilePath(req.event, photo);
        } catch (resolveError) {
          logger.error('Failed to resolve photo path', {
            slug: req.params.slug,
            photoId,
            eventId: req.event.id,
            error: resolveError.message,
            photoPath: photo.path,
            photoFilename: photo.filename
          });
          return res.status(404).json({ error: 'Photo file not found' });
        }
        if (!fs.existsSync(filePath)) {
          logger.error('Photo file does not exist at resolved path', {
            slug: req.params.slug,
            photoId,
            eventId: req.event.id,
            resolvedPath: filePath,
            photoPath: photo.path
          });
          return res.status(404).json({ error: 'Photo file not found' });
        }
        stat = fs.statSync(filePath);
        fileSize = stat.size;
      }

      // Handle video streaming with range requests
      if (isVideo) {
        const range = req.headers.range;

        if (range) {
          const parts = range.replace(/bytes=/, '').split('-');
          const start = parseInt(parts[0], 10);
          const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
          const chunksize = (end - start) + 1;

          res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunksize,
            'Content-Type': photo.mime_type || 'video/mp4',
            'Cache-Control': 'private, max-age=1800',
            'X-Protection-Level': 'basic'
          });

          const file = useStorageBackend
            ? await storage.getRange(storageKey, start, end)
            : fs.createReadStream(filePath, { start, end });
          pipeStreamToResponse(file, res, { context: `video range for photo ${photo.id}` });
        } else {
          res.writeHead(200, {
            'Content-Length': fileSize,
            'Content-Type': photo.mime_type || 'video/mp4',
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'private, max-age=1800',
            'X-Protection-Level': 'basic'
          });
          const file = useStorageBackend
            ? await storage.get(storageKey)
            : fs.createReadStream(filePath);
          pipeStreamToResponse(file, res, { context: `video for photo ${photo.id}` });
        }
        return;
      }

      // Image path
      const watermarkSettings = await watermarkService.getWatermarkSettings();

      const mtimeMs = stat.mtime ? stat.mtime.getTime() : 0;
      const watermarkHash = watermarkSettings?.enabled
        ? `-wm${watermarkSettings.opacity}${watermarkSettings.position}${watermarkSettings.size}`
        : '-nowm';
      const etag = `"${photoId}-${mtimeMs}${watermarkHash}"`;

      if (req.headers['if-none-match'] === etag) {
        return res.status(304).end();
      }

      if (watermarkSettings && watermarkSettings.enabled) {
        // Pre-generated watermarked file: served via the storage backend
        // (managed) or directly from local fs (external).
        if (photo.watermark_path) {
          try {
            if (useStorageBackend) {
              const wmStat = await storage.stat(photo.watermark_path);
              if (wmStat) {
                res.set({
                  'Content-Type': photo.mime_type || 'image/jpeg',
                  'Content-Length': wmStat.size,
                  'Cache-Control': 'private, max-age=1800',
                  'ETag': etag,
                  'X-Protection-Level': 'basic'
                });
                const wmStream = await storage.get(photo.watermark_path);
                return pipeStreamToResponse(wmStream, res, { context: `watermarked photo ${photo.id}` });
              }
            } else {
              const watermarkFilePath = path.join(getStoragePath(), photo.watermark_path);
              if (fs.existsSync(watermarkFilePath)) {
                res.set({
                  'Content-Type': photo.mime_type || 'image/jpeg',
                  'Cache-Control': 'private, max-age=1800',
                  'ETag': etag,
                  'X-Protection-Level': 'basic'
                });
                return res.sendFile(watermarkFilePath);
              }
            }
          } catch (err) {
            logger.warn(`Pre-generated watermark not found for photo ${photoId}, falling back to on-the-fly`);
          }
        }

        // Fallback: apply watermark on-the-fly. applyWatermark needs a
        // local file path (sharp + fs.readFile) — for managed photos in
        // S3 mode, withLocalCopy materializes to a tmp file and cleans up.
        const watermarkedBuffer = useStorageBackend
          ? await withLocalCopy(storageKey, (localPath) =>
            watermarkService.applyWatermark(localPath, watermarkSettings))
          : await watermarkService.applyWatermark(filePath, watermarkSettings);

        // Queue watermark generation in background for next request
        watermarkGeneratorService.generateForPhoto(photo.id)
          .catch(err => logger.warn(`Background watermark generation failed for photo ${photo.id}:`, err.message));

        res.set({
          'Content-Type': photo.mime_type || 'image/jpeg',
          'Cache-Control': 'private, max-age=1800',
          'ETag': etag,
          'X-Protection-Level': 'basic'
        });

        res.send(watermarkedBuffer);
      } else {
        res.set({
          'Cache-Control': 'private, max-age=1800',
          'ETag': etag,
          'X-Protection-Level': 'basic'
        });
        if (useStorageBackend) {
          res.set('Content-Length', stat.size);
          if (photo.mime_type) res.set('Content-Type', photo.mime_type);
          const stream = await storage.get(storageKey);
          pipeStreamToResponse(stream, res, { context: `photo ${photo.id}` });
        } else {
          const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
          res.sendFile(absolutePath);
        }
      }
    } catch (error) {
      errorResponse(res, error, 500, 'Failed to serve photo');
    }
  }
);

// Serve thumbnail
router.get('/:slug/thumbnail/:photoId',
  verifyGalleryAccess,
  async (req, res) => {
    try {
      const { photoId } = req.params;

      const photo = await db('photos')
        .where({ id: photoId, event_id: req.event.id })
        .first();

      if (!photo) {
        return res.status(404).json({ error: 'Photo not found' });
      }

      // Block guest access to hidden photos
      if (photo.visibility === 'hidden' && req.accessLevel !== 'client') {
        return res.status(403).json({ error: 'Photo not available' });
      }

      // Ensure thumbnail exists and is valid, regenerate if needed
      const thumbnailPath = await ensureThumbnail(photo);

      if (!thumbnailPath) {
        logger.error(`Failed to generate thumbnail for photo ${photoId}`);
        return res.status(404).json({ error: 'Thumbnail generation failed' });
      }

      // Read thumbnail metadata via the storage abstraction so we work in
      // both LocalFs and S3 modes (#432). The previous fs.statSync on the
      // resolved local path 500'd in S3 deployments because the thumbnail
      // only exists in the bucket, not on the container's local fs.
      const storage = getStorage();
      const stat = await storage.stat(thumbnailPath);
      if (!stat) {
        logger.error(`Thumbnail not found in storage backend for photo ${photoId}`, { thumbnailPath });
        return res.status(404).json({ error: 'Thumbnail not found' });
      }

      // Log thumbnail access
      await secureImageService.logImageAccess(
        photoId,
        req.event.id,
        req.clientInfo,
        'thumbnail'
      );

      // Check if watermarks are enabled and apply to thumbnail
      const watermarkSettings = await watermarkService.getWatermarkSettings();

      // ETag uses storage stat mtime + photo id + watermark hash.
      const mtimeMs = stat.mtime ? stat.mtime.getTime() : 0;
      const watermarkHash = watermarkSettings?.enabled
        ? `-wm${watermarkSettings.opacity}${watermarkSettings.position}${watermarkSettings.size}`
        : '-nowm';
      const etag = `"thumb-${photoId}-${mtimeMs}${watermarkHash}"`;

      // Check if client has valid cached version
      if (req.headers['if-none-match'] === etag) {
        return res.status(304).end();
      }

      // Set appropriate headers with enhanced security
      res.set({
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'private, max-age=1800', // Reduced cache time
        'Cross-Origin-Resource-Policy': 'cross-origin',
        'X-Content-Type-Options': 'nosniff',
        'X-Protected-Thumbnail': 'true',
        'ETag': etag
      });

      if (watermarkSettings && watermarkSettings.enabled) {
        // Watermarking needs a local file path (sharp + fs.readFile).
        // Materialize via withLocalCopy — no-op in local mode, downloads
        // to a tmp file then cleans up in S3 mode.
        const watermarkedBuffer = await withLocalCopy(thumbnailPath, (localPath) =>
          watermarkService.applyWatermark(localPath, watermarkSettings)
        );
        res.send(watermarkedBuffer);
      } else {
        res.setHeader('Content-Length', stat.size);
        const stream = await storage.get(thumbnailPath);
        pipeStreamToResponse(stream, res, { context: `thumbnail for photo ${photoId}` });
      }
    } catch (error) {
      errorResponse(res, error, 500, 'Failed to serve thumbnail');
    }
  }
);

// Serve hero-optimized image (1920x1080 for full-width hero sections)
router.get('/:slug/hero/:photoId',
  verifyGalleryAccess,
  async (req, res) => {
    try {
      const { photoId } = req.params;

      const photo = await db('photos')
        .where({ id: photoId, event_id: req.event.id })
        .first();

      if (!photo) {
        return res.status(404).json({ error: 'Photo not found' });
      }

      // Block guest access to hidden photos
      if (photo.visibility === 'hidden' && req.accessLevel !== 'client') {
        return res.status(403).json({ error: 'Photo not available' });
      }

      // Check if this is a video - videos don't get hero images
      const isVideo = photo.media_type === 'video' || (photo.mime_type && photo.mime_type.startsWith('video/'));
      if (isVideo) {
        // For videos, redirect to the regular photo endpoint
        return res.redirect(`/api/gallery/${req.params.slug}/photo/${photoId}`);
      }

      // Ensure hero image exists and is valid, regenerate if needed
      const heroPath = await ensureHeroImage(photo);

      if (!heroPath) {
        // If hero generation fails, fall back to original photo
        logger.warn(`Failed to generate hero image for photo ${photoId}, falling back to original`);
        return res.redirect(`/api/gallery/${req.params.slug}/photo/${photoId}`);
      }

      // Hero images are always written via the storage abstraction (see
      // imageProcessor.generateHeroImage), so they're a managed-storage
      // key in both LocalFs and S3 modes (#432). Read via storage.
      const storage = getStorage();
      const stat = await storage.stat(heroPath);
      if (!stat) {
        logger.error('Hero image file does not exist in storage backend', {
          slug: req.params.slug,
          photoId,
          eventId: req.event.id,
          heroPath
        });
        return res.redirect(`/api/gallery/${req.params.slug}/photo/${photoId}`);
      }

      const mtimeMs = stat.mtime ? stat.mtime.getTime() : 0;
      const etag = `"hero-${photoId}-${mtimeMs}"`;
      if (req.headers['if-none-match'] === etag) {
        return res.status(304).end();
      }

      const watermarkSettings = await watermarkService.getWatermarkSettings();

      res.set({
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'private, max-age=3600', // Cache for 1 hour
        'Cross-Origin-Resource-Policy': 'cross-origin',
        'X-Content-Type-Options': 'nosniff',
        'X-Hero-Image': 'true',
        'ETag': etag
      });

      if (watermarkSettings && watermarkSettings.enabled) {
        // applyWatermark needs a local file path; materialize via
        // withLocalCopy so this works in S3 mode too.
        const watermarkedBuffer = await withLocalCopy(heroPath, (localPath) =>
          watermarkService.applyWatermark(localPath, watermarkSettings)
        );
        res.send(watermarkedBuffer);
      } else {
        res.setHeader('Content-Length', stat.size);
        const stream = await storage.get(heroPath);
        pipeStreamToResponse(stream, res, { context: `hero for photo ${photoId}` });
      }
    } catch (error) {
      logger.error('Error serving hero image:', {
        error: error.message,
        photoId: req.params.photoId,
        eventId: req.event?.id
      });
      // Fall back to original photo on any error
      res.redirect(`/api/gallery/${req.params.slug}/photo/${req.params.photoId}`);
    }
  }
);

// Lightbox preview tier (#492). Aspect-preserved JPEG capped at 1920px
// long edge — admin-controlled opt-in via app_settings.lightbox_preview_enabled.
// Mirrors the hero route shape: same auth, ETag from preview mtime,
// fall back to original on any failure so the lightbox never shows a
// broken image. The watermark application path is preserved so a
// preview surfaced in the lightbox carries the same protection a
// guest would see on the full original.
router.get('/:slug/preview/:photoId',
  verifyGalleryAccess,
  async (req, res) => {
    try {
      const { photoId } = req.params;

      const photo = await db('photos')
        .where({ id: photoId, event_id: req.event.id })
        .first();

      if (!photo) {
        return res.status(404).json({ error: 'Photo not found' });
      }

      if (photo.visibility === 'hidden' && req.accessLevel !== 'client') {
        return res.status(403).json({ error: 'Photo not available' });
      }

      // Videos don't get a preview tier — fall through to the regular
      // photo endpoint (which serves the source). The frontend should
      // already be checking media_type before requesting /preview but
      // belt-and-braces in case a stale tab does.
      const isVideo = photo.media_type === 'video' || (photo.mime_type && photo.mime_type.startsWith('video/'));
      if (isVideo) {
        return res.redirect(`/api/gallery/${req.params.slug}/photo/${photoId}`);
      }

      // Lazy generation: ensurePreviewImage returns null on any
      // failure (corrupt source, sharp OOM, storage unavailable, …).
      // Fall back to the original so the lightbox always renders.
      const previewPath = await ensurePreviewImage(photo);
      if (!previewPath) {
        logger.warn(`Failed to generate preview for photo ${photoId}, falling back to original`);
        return res.redirect(`/api/gallery/${req.params.slug}/photo/${photoId}`);
      }

      const storage = getStorage();
      const stat = await storage.stat(previewPath);
      if (!stat) {
        logger.error('Preview file does not exist in storage backend', {
          slug: req.params.slug, photoId, eventId: req.event.id, previewPath,
        });
        return res.redirect(`/api/gallery/${req.params.slug}/photo/${photoId}`);
      }

      const mtimeMs = stat.mtime ? stat.mtime.getTime() : 0;
      const watermarkSettings = await watermarkService.getWatermarkSettings();
      const watermarkHash = watermarkSettings?.enabled
        ? `-wm${watermarkSettings.opacity}${watermarkSettings.position}${watermarkSettings.size}`
        : '-nowm';
      const etag = `"preview-${photoId}-${mtimeMs}${watermarkHash}"`;
      if (req.headers['if-none-match'] === etag) {
        return res.status(304).end();
      }

      res.set({
        // From the key, not hard-coded: a preview of a transparent or animated
        // source is WebP, because JPEG carries neither. `nosniff` below means
        // getting this wrong shows a broken image rather than being silently
        // corrected by the browser. Pre-existing keys have no .webp suffix and
        // are JPEG, so they keep their old header.
        'Content-Type': previewPath.endsWith('.webp') ? 'image/webp' : 'image/jpeg',
        // Cache aggressively — preview only changes on photo
        // re-upload (which generates a new preview key) or settings
        // regenerate (which writes a new mtime + ETag).
        'Cache-Control': 'private, max-age=3600',
        'Cross-Origin-Resource-Policy': 'cross-origin',
        'X-Content-Type-Options': 'nosniff',
        'X-Preview-Image': 'true',
        'ETag': etag,
      });

      if (watermarkSettings && watermarkSettings.enabled) {
        // No Content-Type override here. applyWatermark PRESERVES the source
        // format (watermarkService.js: png -> png, webp -> webp, else jpeg),
        // and its input is this preview — so the output format matches the key
        // the header was already derived from. Forcing image/jpeg would
        // mislabel a watermarked WebP preview, and `nosniff` means the browser
        // will not correct it.
        //
        // What is still lost is the animation: the compositor flattens a
        // multi-frame source to one frame while keeping the WebP container.
        // That is a separate problem and a much larger one.
        const watermarkedBuffer = await withLocalCopy(previewPath, (localPath) =>
          watermarkService.applyWatermark(localPath, watermarkSettings)
        );
        res.send(watermarkedBuffer);
      } else {
        res.setHeader('Content-Length', stat.size);
        const stream = await storage.get(previewPath);
        pipeStreamToResponse(stream, res, { context: `preview for photo ${photoId}` });
      }
    } catch (error) {
      logger.error('Error serving preview image:', {
        error: error.message,
        photoId: req.params.photoId,
        eventId: req.event?.id,
      });
      res.redirect(`/api/gallery/${req.params.slug}/photo/${req.params.photoId}`);
    }
  }
);

// GET /:slug/feedback-settings lives in galleryFeedback.js. A duplicate of it
// used to sit here, and since server.js mounts galleryRoutes before
// galleryFeedback it shadowed the real handler — dropping the per-guest caps
// (#655) from the guest payload, so the gallery could never render the
// favorite/like limits or their counters (#1030).

// Get photo stats
router.get('/:slug/stats', verifyGalleryAccess, async (req, res) => {
  try {
    const totalPhotos = await db('photos')
      .where('event_id', req.event.id)
      .count('id as count')
      .first();
    
    const totalViews = await db('access_logs')
      .where('event_id', req.event.id)
      .where('action', 'view')
      .count('id as count')
      .first();
    
    const totalDownloads = await db('photos')
      .where('event_id', req.event.id)
      .sum('download_count as total')
      .first();
    
    const uniqueVisitors = await db('access_logs')
      .where('event_id', req.event.id)
      .countDistinct('ip_address as count')
      .first();
    
    res.json({
      total_photos: totalPhotos.count,
      total_views: totalViews.count,
      total_downloads: totalDownloads.total || 0,
      unique_visitors: uniqueVisitors.count
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// User photo upload endpoint
router.post('/:eventId/upload', verifyGalleryAccess, denySlideshowToken, async (req, res) => {
  try {
    const eventId = parseInt(req.params.eventId);

    // Verify the event matches the token
    if (req.event.id !== eventId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Check if user uploads are allowed
    if (!req.event.allow_user_uploads) {
      return res.status(403).json({ error: 'User uploads are not allowed for this event' });
    }

    // Ensure temp upload directory exists
    const fs = require('fs');
    const tempUploadDir = '/tmp/uploads/';
    if (!fs.existsSync(tempUploadDir)) {
      try {
        fs.mkdirSync(tempUploadDir, { recursive: true, mode: 0o755 });
        logger.info('Created temp upload directory:', tempUploadDir);
      } catch (mkdirErr) {
        return errorResponse(res, mkdirErr, 500, 'Server configuration error: unable to create upload directory');
      }
    }

    // Import multer and photo processing
    const multer = require('multer');
    const { getAllowedMimeTypes, getMaxFilesPerUpload } = require('../services/uploadSettings');
    const { validateFileType } = require('../utils/fileSecurityUtils');

    // Resolve allowed MIME types from settings
    let allowedMimeTypes;
    try {
      allowedMimeTypes = await getAllowedMimeTypes();
    } catch {
      allowedMimeTypes = ['image/jpeg', 'image/png', 'image/webp'];
    }

    // #613 — per-batch file count was hardcoded to 10 here, so the admin's
    // Settings → General → "Max Files per Upload" value silently didn't
    // apply to guest uploads (only admin uploads honoured it via
    // adminPhotos.js:131). Zszywany reported uploading 16 files succeeded
    // even with the limit set to 10. Mirror the admin path: resolve from
    // settings (cached for 60s in the service) and feed multer both
    // `limits.files` and the `.array(...)` cap. Fall back to the service's
    // default if the read fails.
    let maxFilesPerUpload;
    try {
      maxFilesPerUpload = await getMaxFilesPerUpload();
    } catch {
      maxFilesPerUpload = 500;
    }

    const upload = multer({
      dest: tempUploadDir,
      limits: {
        fileSize: 50 * 1024 * 1024, // 50MB per file (separate concern from #613)
        files: maxFilesPerUpload
      },
      fileFilter: (req, file, cb) => {
        if (validateFileType(file.originalname, file.mimetype, allowedMimeTypes)) {
          cb(null, true);
        } else {
          cb(new Error('Invalid file type'));
        }
      }
    }).array('photos', maxFilesPerUpload);
    
    // Handle upload
    upload(req, res, async (err) => {
      if (err) {
        logger.error('Upload error:', err);
        return res.status(400).json({ error: err.message });
      }
      
      if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: 'No files uploaded' });
      }

      const { queueFilesForProcessing } = require('../services/photoProcessor');
      const rawCategory = req.body.category_id || req.event.upload_category_id || null;
      const numericCategoryId = (() => {
        if (rawCategory === null || rawCategory === undefined) return null;
        const n = parseInt(rawCategory, 10);
        return Number.isFinite(n) ? n : null;
      })();

      try {
        // Queue files as 'pending' — the background worker will process
        // thumbnails / EXIF / dimensions off the request thread (#357).
        const result = await queueFilesForProcessing(req.files, {
          eventId,
          photoType: 'individual',
          categoryId: numericCategoryId,
        });

        res.status(202).json({
          message: 'Photos queued for processing',
          upload_id: result.uploadId,
          count: result.photos.length,
          photo_ids: result.photos.map((p) => p.id),
          photos: result.photos,
          errors: result.errors.length > 0 ? result.errors : undefined,
        });
      } catch (processError) {
        errorResponse(res, processError, 500, 'Failed to process photos');
      }
    });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to upload photos');
  }
});

/**
 * GET /:slug/css-template
 * Get custom CSS template for gallery (public endpoint)
 */
router.get('/:slug/css-template', async (req, res) => {
  try {
    const { slug } = req.params;

    // Find the event by slug
    const event = await db('events')
      .where({ slug })
      .select('css_template_id')
      .first();

    if (!event || !event.css_template_id) {
      // No custom CSS - return 204 No Content
      return res.status(204).send();
    }

    // Get the template if it's enabled
    const template = await db('css_templates')
      .where({ id: event.css_template_id, is_enabled: true })
      .select('css_content')
      .first();

    if (!template || !template.css_content) {
      return res.status(204).send();
    }

    // Return CSS with caching headers
    res.setHeader('Content-Type', 'text/css');
    res.setHeader('Cache-Control', 'public, max-age=3600'); // 1 hour cache
    res.send(template.css_content);
  } catch (error) {
    logger.error('Get CSS template error:', error);
    res.status(500).send('/* Error loading template */');
  }
});

module.exports = router;
