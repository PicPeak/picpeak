const { isGalleryExpired } = require('../../utils/galleryLifecycle');
const express = require('express');
const { db } = require('../../database/db');
const { formatBoolean } = require('../../utils/dbCompat');
const { getAppSetting } = require('../../utils/appSettings');
const { timingSafeEqualStr } = require('../../utils/timingSafe');
const router = express.Router();
const { resolveHeroLogoVisible } = require('../../services/galleryModel');
const { verifyAdminPreview } = require('../../middleware/gallery');
const { noStoreCache } = require('../../middleware/noStoreCache');
const logger = require('../../utils/logger');
const { getEventShareToken, resolveShareIdentifier, buildShareLinkVariants } = require('../../services/shareLinkService');
const { handleAsync, errorResponse } = require('../../utils/routeHelpers');
const { isGalleryHidden } = require('../../utils/revealMode');
const { NotFoundError } = require('../../utils/errors');
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

// Admin preview of an unpublished gallery (#1386). /info has honoured
// admin_preview since #868, but this route never did, so the short-URL form
// of a draft's share link 404'd with "Gallery Not Found" while the long slug
// form worked — exactly the shape the reporter described.
//
// Deliberately a second lookup on the miss path rather than a widened filter:
// the published case keeps its single query and cannot start returning drafts
// however this evolves, and an unverified caller never gets so far as knowing
// the draft exists.
async function resolveDraftForAdminPreview(req, identifier) {
  // decodeAdminPreview requires this flag anyway, so checking it up front costs
  // nothing and keeps an unknown identifier from paying for a second set of
  // lookups on the public 404 path.
  if (req.query?.admin_preview !== '1') return null;
  const result = await resolveShareIdentifier(identifier, { includeDrafts: true });
  if (!result) return null;
  // verifyAdminPreview re-reads the event with SELECT * off the slug, so give
  // it the slug rather than the partial row selected above.
  req.requestedSlug = result.event.slug;
  if (await verifyAdminPreview(req)) return result;
  throwIfPasswordChangeRequired(req);
  return null;
}

// verifyAdminPreview answers a refused preview with `false`, and the routes in
// this file turn that into "not found". Right for everything else, wrong for
// an admin whose only problem is a pending password rotation: they landed on
// the gallery-not-found page with no hint that the admin area was waiting for
// them. That refusal is about the account, not the gallery, so it is reported
// as the 403 MUST_CHANGE_PASSWORD adminAuth would answer. Every other refusal
// (FORBIDDEN, a revoked session) still reads as not found, so a scoped admin
// learns nothing new about a draft they cannot open.
function throwIfPasswordChangeRequired(req) {
  if (req.adminPreviewDenied?.code === 'MUST_CHANGE_PASSWORD') throw req.adminPreviewDenied;
}

router.get('/resolve/:identifier', handleAsync(async (req, res) => {
  const { identifier } = req.params;
  let result = await resolveShareIdentifier(identifier);

  if (!result) {
    result = await resolveDraftForAdminPreview(req, identifier);
  }

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

// Verify share token. no-store: this is an authorization decision — a cached
// `{ valid: true }` would keep answering for a token the admin has rotated.
router.get('/:slug/verify-token/:token', noStoreCache, handleAsync(async (req, res) => {
  const { slug, token } = req.params;

  const event = await db('events')
    .where({ slug, is_active: formatBoolean(true), is_archived: formatBoolean(false) })
    .select('id', 'share_link', 'share_token', 'is_draft')
    .first();

  if (!event) {
    throw new NotFoundError('Gallery');
  }

  // Drafts are visible to a verified admin preview only (#1386). Without this
  // the preview clears /resolve and then 404s one step later, here.
  if (event.is_draft) {
    req.requestedSlug = slug;
    if (!await verifyAdminPreview(req)) {
      throwIfPasswordChangeRequired(req);
      throw new NotFoundError('Gallery');
    }
  }

  const expectedToken = getEventShareToken(event);
  if (!expectedToken || !timingSafeEqualStr(String(token), expectedToken)) {
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
        'id',
        'created_by',
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
        'reveal_mode',
        'reveal_at',
        'revealed_at',
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
        'login_logo_visible',
        'header_style',
        'hero_divider_style',
        'hero_image_anchor',
        'is_draft',
        'default_photo_sort',
        // Per-event promotional override (#440). Resolution into a
        // ready-to-render markdown string happens below so the
        // frontend doesn't have to know about modes.
        'promo_mode',
        'promo_markdown',
        'info_mode',
        'info_markdown'
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

    // Admin preview (#868) bypasses both the draft gate and — below — the
    // password gate. Computed once and reused.
    const adminPreview = await verifyAdminPreview(req, event);
    // See throwIfPasswordChangeRequired. This route answers its refusals inline
    // rather than through the error handler, so it does the same here.
    if (req.adminPreviewDenied?.code === 'MUST_CHANGE_PASSWORD') {
      return res.status(403).json({ error: req.adminPreviewDenied.message, code: req.adminPreviewDenied.code });
    }
    // Check if event is a draft (allow admin preview)
    if (event.is_draft && !adminPreview) {
      return res.status(404).json({ error: 'Gallery is not yet published' });
    }
    
    // If token provided, verify it matches the share link
    if (token) {
      const expectedToken = getEventShareToken(event);
      if (!expectedToken || !timingSafeEqualStr(String(token), expectedToken)) {
        return res.status(404).json({ error: 'Invalid gallery link' });
      }
    }
    
    // Admin preview skips the guest password on published, protected galleries
    // (#868) — the admin already sees every photo through the admin routes.
    const requiresPassword = adminPreview
      ? false
      : !(event.require_password === false || event.require_password === 0 || event.require_password === '0');
    const globalHeroLogoVisible = await getAppSetting('branding_logo_display_hero', true);
    const globalLogoSize = await getAppSetting('branding_logo_size', 'medium');

    res.json({
      event_name: event.event_name,
      event_type: event.event_type,
      event_date: event.event_date,
      expires_at: event.expires_at,
      is_active: event.is_active,
      is_expired: !event.is_active || isGalleryExpired(event),
      requires_password: requiresPassword,
      color_theme: event.color_theme,
      allow_downloads: !(event.allow_downloads === false || event.allow_downloads === 0 || event.allow_downloads === '0'),
      allow_user_uploads: event.allow_user_uploads === true || event.allow_user_uploads === 1 || event.allow_user_uploads === '1',
      // Reveal mode (#838): effective hidden state (computed, time-exact) so
      // the landing page can hint at the reveal before login too.
      hidden_until_reveal: isGalleryHidden(event),
      reveal_at: isGalleryHidden(event) ? (event.reveal_at || null) : null,
      disable_right_click: event.disable_right_click === true || event.disable_right_click === 1 || event.disable_right_click === '1',
      watermark_downloads: event.watermark_downloads === true || event.watermark_downloads === 1 || event.watermark_downloads === '1',
      watermark_text: event.watermark_text,
      enable_devtools_protection: event.enable_devtools_protection === true || event.enable_devtools_protection === 1 || event.enable_devtools_protection === '1',
      use_canvas_rendering: event.use_canvas_rendering === true || event.use_canvas_rendering === 1 || event.use_canvas_rendering === '1',
      hero_logo_visible: resolveHeroLogoVisible(event.hero_logo_visible, globalHeroLogoVisible),
      // #894: only an explicit false hides the logo on the password page;
      // NULL keeps the default (show).
      login_logo_visible: !(event.login_logo_visible === false || event.login_logo_visible === 0 || event.login_logo_visible === '0'),
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
      promo_markdown: event.promo_markdown || null,
      // Info banner (#932). Same inherit/custom/off semantics as promo,
      // resolved against branding_info_markdown from public settings.
      info_mode: event.info_mode || 'inherit',
      info_markdown: event.info_markdown || null
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

module.exports = router;
