const express = require('express');
const jwt = require('jsonwebtoken');
const { db, logActivity } = require('../database/db');
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
// Preserve the admin-preview flag across internal photo redirects (#981 review).
// The redirected request carries no gallery JWT, so without the flag it would
// fall back to the draft/password gate and 404 the derivative.
const withPreview = (req, url) => (req.isAdminPreview ? `${url}${url.includes('?') ? '&' : '?'}admin_preview=1` : url);
const { resolveGuest } = require('../middleware/guestAuth');
const { generateGuestIdentifier } = require('../middleware/feedbackRateLimit');
const secureImageService = require('../services/secureImageService');
const logger = require('../utils/logger');
const { resolvePhotoFilePath } = require('../services/photoResolver');
const { getEventCategoriesOrdered } = require('../utils/categoryOrder');
const { getEventShareToken, resolveShareIdentifier, buildShareLinkVariants } = require('../services/shareLinkService');
const { handleAsync, errorResponse } = require('../utils/routeHelpers');
const { isGalleryHidden, guestBlockedByReveal, blockHiddenGallery } = require('../utils/revealMode');
const { toIso } = require('../utils/dateNormalize');
const { NotFoundError } = require('../utils/errors');
const { ensureThumbnail, ensureHeroImage, ensurePreviewImage, withLocalCopy, resizeToBox } = require('../services/imageProcessor');
const downloadZipService = require('../services/downloadZipService');
const { renderPhotoForDownload } = require('../services/downloadRendition');
const downloadJobService = require('../services/downloadJobService');
// Download resolutions (#858) — the standard size a gallery hands out, plus
// validation of any guest-picked override.
const {
  resolveEventDownloadPolicy,
  pickRequestedResolution,
  parseResolution,
} = require('../utils/downloadResolutions');
const { applyPhotoVisibilityFilter, canSeeHiddenPhotos } = require('../utils/photoVisibility');
const {
  getUseOriginalFilenames,
  pickRawDownloadName,
  getZipEntryNames,
} = require('../services/downloadFilenameService');
const { buildContentDisposition } = require('../utils/filenameSanitizer');
const { getStorage } = require('../services/storage');

// Formats whose ORIGINAL bytes a browser can't render in an <img> (HEIC/HEIF,
// camera RAW/DNG). For these the lightbox must be served the generated JPEG
// preview instead of `url` (the original) — otherwise it shows a broken image.
// So we force `preview_url` for them regardless of the lightbox_preview_enabled
// toggle. Detection is by MIME first, extension as a fallback (browsers report
// these MIMEs inconsistently). EXPERIMENTAL: whether a preview actually renders
// still depends on the backend being able to decode the source (HEVC-in-HEIC on
// the prod image; exiftool for DNG) — see #821.
const NON_DISPLAYABLE_ORIGINAL_EXT = new Set(['heic', 'heif', 'dng']);
const NON_DISPLAYABLE_ORIGINAL_MIME = new Set(['image/heic', 'image/heif', 'image/x-adobe-dng']);
function originalNeedsPreview(photo) {
  const mime = (photo.mime_type || '').toLowerCase();
  if (NON_DISPLAYABLE_ORIGINAL_MIME.has(mime)) return true;
  const name = photo.original_filename || photo.filename || '';
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  return NON_DISPLAYABLE_ORIGINAL_EXT.has(ext);
}
const { setGalleryAuthCookies } = require('../utils/tokenUtils');
// Read globals from app_settings (the real table) — settingsService.getSetting
// queries a non-existent `settings` table and throws.
const { getSlideshowGlobals } = require('../utils/slideshowGlobals');
const { isFeatureEnabled } = require('../middleware/requireFeatureFlag');
const fs = require('fs');

// Get storage path from environment or default
const getStoragePath = () => process.env.STORAGE_PATH || path.join(__dirname, '../../../storage');

// "Gallery opened" for the admin notification bell (#746). The photo-list
// endpoint fires on every gallery page load, so notifying per hit would spam
// the bell — debounce to at most one notification per event per window. The
// map is in-memory on purpose: losing it on restart merely allows one extra
// notification, and it costs the hot view path zero DB reads.
const GALLERY_OPENED_DEBOUNCE_MS = 6 * 60 * 60 * 1000; // 6h
const galleryOpenedNotifiedAt = new Map();
// #746 covers CLIENT activity too — attribute the actor from the session
// instead of hard-coding 'guest', so a customer opening from the portal
// isn't mislabeled (codex review of #849 round 3).
function galleryActor(req) {
  // Portal tokens run as accessLevel 'guest' but carry via:'customer'
  // (req.viaCustomer); PIN-client logins carry accessLevel 'client'.
  // Both are customers, not guests (codex review of #849, final round).
  const isCustomer = !!(req && (req.viaCustomer || req.accessLevel === 'client'));
  return { type: isCustomer ? 'customer' : 'guest' };
}
function notifyGalleryOpened(event, req) {
  // Customer-PORTAL opens already log `customer_event_access` on the
  // access-token mint — a second `gallery_opened` per portal click would
  // double-notify. Keyed on the portal provenance (req.viaCustomer), NOT
  // on accessLevel: PIN-client logins are 'client' without any other
  // open signal and must keep notifying (codex review of #849, final
  // round — the previous check had this inverted).
  if (req && req.viaCustomer) return;
  const now = Date.now();
  const last = galleryOpenedNotifiedAt.get(event.id) || 0;
  if (now - last < GALLERY_OPENED_DEBOUNCE_MS) return;
  galleryOpenedNotifiedAt.set(event.id, now);
  // Fire-and-forget — logActivity swallows its own errors.
  logActivity('gallery_opened', {}, event.id, galleryActor(req));
}

// Single-photo saves are frequent (a guest saving 30 photos = 30 route
// hits) — debounce like gallery_opened so the bell gets one "guest is
// downloading photos" signal per event per window instead of a flood
// (codex review of #849). ZIP downloads stay un-debounced: rare, high
// signal. Exact per-photo counts remain in access_logs/analytics.
const SINGLE_DOWNLOAD_DEBOUNCE_MS = 60 * 60 * 1000; // 1h
const singleDownloadNotifiedAt = new Map();
function notifySinglePhotoDownload(event, req) {
  const now = Date.now();
  const last = singleDownloadNotifiedAt.get(event.id) || 0;
  if (now - last < SINGLE_DOWNLOAD_DEBOUNCE_MS) return;
  singleDownloadNotifiedAt.set(event.id, now);
  logActivity('gallery_downloaded', { scope: 'single' }, event.id, galleryActor(req));
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
    const adminPreview = isAdminPreview(req);
    // Check if event is a draft (allow admin preview)
    if (event.is_draft && !adminPreview) {
      return res.status(404).json({ error: 'Gallery is not yet published' });
    }
    
    // If token provided, verify it matches the share link
    if (token) {
      const expectedToken = getEventShareToken(event);
      if (!expectedToken || token !== expectedToken) {
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
      is_expired: !event.is_active || (event.expires_at && new Date(event.expires_at) < new Date()),
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
function slideshowPhotosQuery(eventId, categoryId = null) {
  const q = db('photos')
    .where('photos.event_id', eventId)
    .where(function() {
      this.where('photos.processing_status', 'complete').orWhereNull('photos.processing_status');
    })
    .where(function() {
      this.where('photos.visibility', 'visible').orWhereNull('photos.visibility');
    });
  // Category filter (#202) — keep the /session + /state count in sync with the
  // photos the kiosk actually renders.
  if (categoryId) q.where('photos.category_id', categoryId);
  return q;
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
async function slideshowSettings(event, req) {
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
  // QR overlay (#837): like the watermark, the LOOK is global-only and the
  // per-event `show_qr` tri-state (NULL = inherit) decides visibility. The QR
  // encodes the gallery share URL and ships as a data URI so the public
  // slideshow client needs no QR library and no extra authenticated endpoint.
  const qrOverride = event.show_qr;
  const qrInherit = (qrOverride === null || qrOverride === undefined);
  const qrEnabled = qrInherit ? g.qr_enabled : (qrOverride === true || qrOverride === 1 || qrOverride === '1');
  let qr = null;
  if (qrEnabled) {
    const dataUrl = await slideshowQrDataUrl(event, req);
    if (dataUrl) {
      qr = {
        data_url: dataUrl,
        position: g.qr_position,
        opacity: g.qr_opacity,
        size: g.qr_size,
      };
    }
  }

  return {
    interval_ms: event.show_interval_ms || 5000,
    transition: event.show_transition || 'crossfade',
    transition_ms: event.show_transition_ms || 800,
    colorfilter: event.show_colorfilter || 'none',
    // Play order (#202): 'chronological' | 'random'. The client shuffles when
    // 'random' so live-appended uploads keep working.
    order: event.show_order || 'chronological',
    fit: g.fit,
    watermark,
    qr,
  };
}

// The state endpoint is polled every ~3s per projector — cache the generated
// QR data URI per share URL instead of re-encoding on every poll. Bounded:
// entries live for past events / rotated tokens too, so without eviction the
// map would grow with every share URL ever displayed (codex review of #848).
// Insertion-order eviction is enough — concurrently-shown events stay hot.
const SLIDESHOW_QR_CACHE_MAX = 50;
// Keyed by event id (NOT by URL): the origin is caller-influenced when the
// configured base is loopback, so URL-keyed caching would let a slideshow
// -link holder force a fresh QRCode.toDataURL per request with unique
// origins — a cheap CPU-exhaustion path (codex review of #848,
// confirmation round). Per-event entries + a regeneration throttle bound
// the encode rate regardless of what the caller sends.
const SLIDESHOW_QR_REGEN_MS = 60_000;
const slideshowQrCache = new Map(); // eventId -> { url, dataUrl, at }
// Localhost/relative guard (codex review of #848): with the compose-default
// FRONTEND_URL=http://localhost:3000 (or none configured) the QR would send
// scanning phones to THEIR localhost. The state poll comes from the kiosk
// browser itself, so its Host header + protocol are exactly the public
// origin guests can reach — prefer that whenever the configured base is
// missing or loopback. trust proxy is configured, so req.protocol respects
// X-Forwarded-Proto behind the standard reverse-proxy setups.
const QR_LOCAL_BASE_RE = /^https?:\/\/(localhost|127\.|0\.0\.0\.0|\[::1\])/i;
const QR_ORIGIN_RE = /^https?:\/\/[^\s/]+$/i;
async function slideshowQrDataUrl(event, req) {
  try {
    const shareToken = getEventShareToken(event);
    if (!shareToken) return null;
    let { shareUrl, sharePath } = await buildShareLinkVariants({ slug: event.slug, shareToken });
    if (!/^https?:\/\//i.test(shareUrl) || QR_LOCAL_BASE_RE.test(shareUrl)) {
      // Prefer the kiosk's own window.location.origin (?origin=, validated):
      // req.get('host') is NOT the browser origin behind the standard
      // proxies — frontend/nginx.conf forwards $host (port stripped), so a
      // compose LAN deployment on :3000 would encode port 80. A LOOPBACK
      // kiosk origin is rejected too: it is no more guest-reachable than
      // the loopback base it would replace (codex review of #848).
      const rawOrigin = req?.query?.origin;
      const queryOrigin = typeof rawOrigin === 'string' && QR_ORIGIN_RE.test(rawOrigin) && !QR_LOCAL_BASE_RE.test(rawOrigin)
        ? rawOrigin.replace(/\/$/, '')
        : null;
      const host = req && req.get ? req.get('host') : null;
      const hostOrigin = host ? `${req.protocol}://${host}` : null;
      if (queryOrigin) shareUrl = `${queryOrigin}${sharePath}`;
      else if (hostOrigin && !QR_LOCAL_BASE_RE.test(hostOrigin)) shareUrl = `${hostOrigin}${sharePath}`;
      // Still loopback/relative → no reachable URL exists; suppress the
      // overlay rather than encode a QR that sends phones to localhost.
      else return null;
    }

    const cached = slideshowQrCache.get(event.id);
    if (cached && cached.url === shareUrl) return cached.dataUrl;
    // URL differs from the cached one: NEVER serve the mismatched artifact —
    // a slideshow-token holder could otherwise poison the projector's QR
    // with an attacker origin for a whole throttle window (codex review of
    // #848, final round). Inside the window the overlay is briefly
    // suppressed instead; regeneration stays bounded per event.
    if (cached && Date.now() - cached.at < SLIDESHOW_QR_REGEN_MS) {
      return cached.pending ? cached.dataUrl : null;
    }
    // Single-flight: concurrent polls on a cold cache must not each
    // schedule their own 512px encode — reserve the entry with a shared
    // promise before awaiting.
    if (cached && cached.pending && cached.url === shareUrl) return cached.pending;
    const QRCode = require('qrcode');
    const entry = { url: shareUrl, dataUrl: null, at: Date.now(), pending: null };
    entry.pending = QRCode.toDataURL(shareUrl, { width: 512, margin: 4 }).then((dataUrl) => {
      entry.dataUrl = dataUrl;
      entry.pending = null;
      return dataUrl;
    }).catch((e) => {
      slideshowQrCache.delete(event.id);
      throw e;
    });
    if (!slideshowQrCache.has(event.id) && slideshowQrCache.size >= SLIDESHOW_QR_CACHE_MAX) {
      slideshowQrCache.delete(slideshowQrCache.keys().next().value);
    }
    slideshowQrCache.set(event.id, entry);
    return await entry.pending;
  } catch (e) {
    logger.error('Slideshow QR generation failed:', e);
    return null;
  }
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

  const [{ count }] = await slideshowPhotosQuery(event.id, event.show_category_id).count('* as count');

  res.json({
    token: sessionToken,
    event: {
      event_name: event.event_name,
      event_type: event.event_type,
      color_theme: event.color_theme
    },
    settings: await slideshowSettings(event, req),
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

  const [{ count }] = await slideshowPhotosQuery(event.id, event.show_category_id).count('* as count');

  res.json({
    ...(await slideshowSettings(event, req)),
    photo_count: parseInt(count, 10) || 0,
    expires_at: event.expires_at || null
  });
}));

// Get all photos
router.get('/:slug/photos', verifyGalleryAccess, resolveGuest, async (req, res) => {
  try {
    // Get filter and sort parameters from query
    const { filter, guest_id, sort = 'upload_date', order = 'desc' } = req.query;

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

    // Live Slideshow category filter (#202). Enforced server-side so the kiosk
    // viewer can't widen the set: when the event pins show_category_id, the
    // slideshow only sees that category. NULL = all photos (unchanged).
    if (req.accessLevel === 'slideshow' && req.event.show_category_id) {
      photosQuery = photosQuery.where('photos.category_id', req.event.show_category_id);
    }

    // Apply sort option
    if (sort === 'capture_date') {
      // Sort by capture date, falling back to uploaded_at if capture date is null
      photosQuery = photosQuery.orderByRaw('COALESCE(photos.captured_at, photos.uploaded_at) ' + sortOrder);
    } else if (sort === 'filename') {
      photosQuery = photosQuery.orderBy('photos.filename', sortOrder);
    } else {
      // Default: sort by upload date
      photosQuery = photosQuery.orderBy('photos.uploaded_at', sortOrder);
    }

    // Reveal mode (#838): while the gallery is hidden, plain guests get
    // the event shell with an empty photo/category set plus the
    // hidden_until_reveal flag — the frontend renders the upload-only view
    // from it. Slideshow, client access and the admin preview bypass
    // (guestBlockedByReveal). Enforced here, not just in the UI.
    const hiddenForGuest = guestBlockedByReveal(req);

    // Execute the query
    let photos = hiddenForGuest ? [] : await photosQuery;
    
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

        let guestFeedbackByType = null;
        if (guest_id) {
          const guestFeedbackRows = await db('photo_feedback')
            .where({ event_id: req.event.id, guest_identifier: guest_id })
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

        if (filterTokens.has('liked')) {
          includeGuestMatches('like');
          includeBy(photo => (photo.like_count || 0) > 0);
        }

        if (filterTokens.has('favorited')) {
          includeGuestMatches('favorite');
          includeBy(photo => (photo.favorite_count || 0) > 0);
        }

        if (filterTokens.has('rated')) {
          includeGuestMatches('rating');
          includeBy(photo => (photo.average_rating || 0) > 0);
        }

        if (filterTokens.has('commented')) {
          includeGuestMatches('comment');
          const commentedRows = await db('photo_feedback')
            .where({ event_id: req.event.id, feedback_type: 'comment', is_approved: true, is_hidden: false })
            .groupBy('photo_id')
            .select('photo_id');
          commentedRows.forEach(row => include.add(row.photo_id));
        }

        photos = photos.filter(photo => include.has(photo.id));
      }
    }
    
    // Check if feedback should be visible to guests
    const feedbackService = require('../services/feedbackService');
    const feedbackSettings = await feedbackService.getEventFeedbackSettings(req.event.id);
    const showFeedbackToGuests = isClient || parseBooleanInput(feedbackSettings.show_feedback_to_guests, true);

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
        .where({ event_id: req.event.id, feedback_type: 'like' })
        .whereIn('photo_id', photos.map(p => p.id));
      if (req.guest?.id) {
        likeQuery.where('guest_id', req.guest.id);
      } else {
        likeQuery.where('guest_identifier', generateGuestIdentifier(req));
      }
      const likedRows = await likeQuery.select('photo_id');
      likedRows.forEach(row => likedPhotoIds.add(row.photo_id));
    }

    // People in each photo (#1074). Two independent gates: the feature must
    // be on for this event AND, for a plain guest, the photographer must have
    // left the strip visible. A client (PIN access) is the photographer's own
    // view, so faces_visible_to_guests doesn't restrict them.
    //
    // `photos` is already visibility-filtered above, and this only ever asks
    // about ids in that set, so it cannot widen what the caller sees.
    let peopleEnabled = false;
    let personIdsByPhoto = new Map();
    try {
      const { isEnabledForEvent, areFacesVisibleToGuests } = require('../services/faceSettings');
      if (photos.length > 0 && await isEnabledForEvent(req.event)) {
        peopleEnabled = isClient || areFacesVisibleToGuests(req.event);
        if (peopleEnabled) {
          const { getPersonIdsByPhoto } = require('../services/facePeopleService');
          personIdsByPhoto = await getPersonIdsByPhoto(
            req.event.id,
            photos.map(p => p.id),
            { forAdmin: isClient }
          );
        }
      }
    } catch (err) {
      // A face-feature failure must never take down the gallery payload.
      logger.warn(`gallery: person_ids lookup failed for event ${req.event.id}`, { error: err.message });
      peopleEnabled = false;
      personIdsByPhoto = new Map();
    }

    // Get actual categories used by photos in this event
    // This includes both global categories and event-specific ones
    const usedCategoryIds = hiddenForGuest ? [] : await db('photos')
      .where('event_id', req.event.id)
      .whereNotNull('category_id')
      .distinct('category_id')
      .pluck('category_id');

    // Fetch category details from photo_categories table
    let categories = [];
    if (usedCategoryIds.length > 0) {
      // Resolved category order (#782): per-event override, else global
      // default, else name — restricted to categories that have photos.
      const categoryDetails = await getEventCategoriesOrdered(req.event.id, {
        onlyIds: usedCategoryIds,
        select: ['c.id', 'c.name', 'c.slug', 'c.is_global', 'c.hero_photo_id', 'c.allow_downloads'],
      });

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
    // Admin preview (#868) is excluded from guest analytics + the "gallery
    // opened" bell — it's the photographer looking at their own gallery.
    if (req.accessLevel !== 'slideshow' && !req.isAdminPreview) {
      await db('access_logs').insert({
        event_id: req.event.id,
        ip_address: req.ip,
        user_agent: req.headers['user-agent'],
        action: 'view'
      });
      notifyGalleryOpened(req.event, req);
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
    const downloadPolicy = await resolveEventDownloadPolicy(req.event);

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
        // Download resolutions (#858). `choices` drives the picker modal and is
        // empty when the picker is off, so the UI can never offer a size the
        // server would reject.
        download_resolution: {
          standard: downloadPolicy.standard,
          picker_enabled: downloadPolicy.pickerEnabled,
          choices: downloadPolicy.pickerEnabled ? downloadPolicy.choices : [],
        },
        // Reveal mode (#838): armed flag lets an open VISIBLE gallery keep
        // polling so a re-hide propagates without a manual reload.
        reveal_armed: parseBooleanInput(req.event.reveal_mode, false),
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
        // Promo banner override (#440). GalleryView has always read
        // promo_mode from THIS payload, but it was never sent — so every
        // per-event promo override silently resolved to 'inherit' and a
        // gallery set to 'off' still showed the global banner.
        promo_mode: req.event.promo_mode || 'inherit',
        promo_markdown: req.event.promo_markdown || null,
        // Info banner override (#932). GalleryAuthContext refreshes its cached
        // event from THIS payload, so the fields have to travel here — /info
        // alone isn't enough, the context stops reading it once the guest is
        // authenticated.
        info_mode: req.event.info_mode || 'inherit',
        info_markdown: req.event.info_markdown || null,
        download_zip_ready: !!(req.event.download_zip_path && req.event.download_zip_generated_at),
        // Mirror of the admin-side toggle so the lightbox can decide
        // whether to surface original camera filenames (#508).
        use_original_filenames: useOriginalFilenames,
        // "People in this gallery" (#1074). False whenever the global flag
        // is off, detection is off for this event, or the photographer chose
        // to keep the strip to themselves — the frontend renders no face UI
        // at all in that case.
        people_enabled: peopleEnabled,
        ...protectionSettings
      },
      // Reveal mode (#838): the guest UI switches to the upload-only view
      // on this flag; reveal_at lets it show the scheduled time.
      hidden_until_reveal: hiddenForGuest,
      reveal_at: hiddenForGuest ? (req.event.reveal_at || null) : undefined,
      categories: categories,
      photos: photos.map(photo => {
        const useJwtUrl = (protectionSettings.protection_level === 'basic' || protectionSettings.protection_level === 'standard');
        // Watermark version (cache-busting) + admin-preview flag (#868). In
        // preview mode no gallery cookie is minted, so each <img> request must
        // re-assert the admin session — thread the flag onto every /api/gallery
        // image URL so the browser sends it (the admin_token cookie rides along
        // same-origin).
        const imgQuery = [wmVersion, req.isAdminPreview ? 'admin_preview=1' : ''].filter(Boolean).join('&');
        const wmQuery = imgQuery ? `?${imgQuery}` : '';
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
          preview_url: (lightboxPreviewEnabled || originalNeedsPreview(photo))
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
          // toIso: on SQLite installs rows written with a raw Date (e.g.
          // the pre-fix archive-restore path) hold epoch numbers — the
          // Timeline layout's parseISO() crashes on those (#485 class).
          uploaded_at: toIso(photo.uploaded_at),
          // Image dimensions for layout calculations
          width: photo.width || null,
          height: photo.height || null,
          // Fixed: Use the calculated useJwtUrl variable instead of recalculating
          requires_token: !useJwtUrl,
          // EXIF capture date
          captured_at: toIso(photo.captured_at) || null,
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
          // People in this photo (#1074). Empty array when the feature is
          // off for this event or hidden from guests, so the frontend has
          // one shape to handle. Riding along on this payload is what keeps
          // face filtering client-side and instant, like the category and
          // liked/rated filters.
          person_ids: personIdsByPhoto.get(photo.id) || [],
          // Visibility (only included for clients)
          ...(isClient ? { visibility: photo.visibility || 'visible' } : {})
        };
      })
    });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to fetch photos');
  }
});

/**
 * People in this gallery (#1074).
 *
 * Returns [] rather than 403 whenever the feature is unavailable — a guest
 * must not be able to tell "this gallery has no people" from "this gallery
 * has the feature switched off". Same reasoning as reveal mode returning an
 * empty photo set rather than an error.
 *
 * Counts and cover faces are computed against the caller's own visibility
 * scope inside facePeopleService; nothing here reads face_count_total.
 */
router.get('/:slug/people', verifyGalleryAccess, resolveGuest, async (req, res) => {
  try {
    const isClient = req.accessLevel === 'client';
    const { isEnabledForEvent, areFacesVisibleToGuests, getThresholds } =
      require('../services/faceSettings');

    if (!(await isEnabledForEvent(req.event))) {
      return res.json({ people: [] });
    }
    if (!isClient && !areFacesVisibleToGuests(req.event)) {
      return res.json({ people: [] });
    }
    // While a gallery is hidden behind reveal mode (#838), a plain guest sees
    // no photos — so they see no people either.
    if (guestBlockedByReveal(req)) {
      return res.json({ people: [] });
    }

    const { listPeople, getScanStatus } = require('../services/facePeopleService');
    const thresholds = await getThresholds();

    const people = await listPeople(req.event.id, {
      isClient,
      forAdmin: false,
      minClusterSize: thresholds.face_min_cluster_size,
    });

    // Drives the "Finding people… 240/1200" progress line during a backfill.
    // Scoped to what this viewer may see — an unscoped total would leak the
    // number of hidden photos through the progress bar.
    const status = await getScanStatus(req.event.id, { isClient });

    res.json({
      people,
      scan: {
        in_progress: status.in_progress,
        scanned: status.scanned,
        total: status.total,
      },
    });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to fetch people');
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
router.get('/:slug/download/:photoId', verifyGalleryAccess, denySlideshowToken, blockHiddenGallery, async (req, res) => {
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

    // Download resolution (#858). Resolved BEFORE the counters below: a
    // rejected resolution must not inflate download stats, which a guest
    // could otherwise do by replaying ?resolution=bogus.
    const isVideo = photo.media_type === 'video'
      || (photo.mime_type && photo.mime_type.startsWith('video/'));
    const policy = await resolveEventDownloadPolicy(req.event);
    const requested = pickRequestedResolution(policy, req.query.resolution);
    if (requested === null) {
      return res.status(400).json({ error: 'Resolution not available for this gallery' });
    }
    const box = isVideo ? null : parseResolution(requested);

    // Admin preview (#868) downloads are excluded from the download count +
    // guest analytics — kept out of client-facing stats.
    if (!req.isAdminPreview) {
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
    }
    // Surface in the admin notification bell (#746) — debounced, and only
    // once the response actually finished: notifying up-front would log a
    // download that then 404s/fails and the debounce would suppress the
    // next real one for an hour (codex review of #849).
    res.on('finish', () => {
      if (res.statusCode < 400 && !req.isAdminPreview) notifySinglePhotoDownload(req.event, req);
    });
    
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

    // The gallery's standard applies to EVERY ordinary download, single photos
    // included — otherwise a lowered standard is trivially bypassed by
    // downloading photos one at a time. `box` was resolved above, before the
    // counters. Videos have no resize path and always ship as-is.
    if (shouldApplyWatermark || box) {
      // Resize BEFORE watermarking: applyWatermark sizes the mark relative to
      // its input's width, so watermarking the original and then shrinking
      // would resample the mark and waste work on discarded pixels.
      //
      // With no resize (the default 'original' standard) hand applyWatermark
      // the PATH, not a buffer: buffer inputs deliberately skip its cache, so
      // buffering here would re-run sharp over the full-size original on every
      // download and regress the pre-#858 watermark performance.
      const effectiveSettings = shouldApplyWatermark ? {
        ...watermarkSettings,
        enabled: true,
        text: req.event.watermark_text || watermarkSettings?.text || 'Protected'
      } : null;

      let buffer;
      if (!box) {
        buffer = await watermarkService.applyWatermark(filePath, effectiveSettings);
      } else {
        buffer = await resizeToBox(await fs.promises.readFile(filePath), box);
        if (shouldApplyWatermark) {
          buffer = await watermarkService.applyWatermark(buffer, effectiveSettings);
        }
      }

      res.set({
        'Content-Type': photo.mime_type || 'image/jpeg',
        'Content-Disposition': contentDisposition,
        'Content-Length': buffer.length
      });

      res.send(buffer);
    } else {
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
    }
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

router.get('/:slug/download-all', verifyGalleryAccess, denySlideshowToken, blockHiddenGallery, async (req, res) => {
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
          // Admin preview (#868): stream the ZIP but keep it out of stats.
          if (!req.isAdminPreview) {
            db('access_logs').insert({
              event_id: req.event.id,
              ip_address: req.ip,
              user_agent: req.headers['user-agent'],
              action: 'download_all_presigned'
            }).catch(() => {});
            bumpEventDownloadCounts(req.event.id).catch(() => {});
            // Surface in the admin notification bell (#746).
            logActivity('gallery_downloaded', { scope: 'all' }, req.event.id, galleryActor(req));
          }
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
      stream.pipe(res);

      // Log bulk download (admin preview #868 excluded — stats stay client-only).
      if (!req.isAdminPreview) {
        db('access_logs').insert({
          event_id: req.event.id,
          ip_address: req.ip,
          user_agent: req.headers['user-agent'],
          action: 'download_all'
        }).catch(() => {});
        bumpEventDownloadCounts(req.event.id).catch(() => {});
        // Surface in the admin notification bell (#746) — only once the
        // stream actually finished; logging at pipe-time would report
        // downloads that then broke mid-transfer (codex review of #849).
        res.on('finish', () => {
          if (res.statusCode < 400) logActivity('gallery_downloaded', { scope: 'all' }, req.event.id, galleryActor(req));
        });
      }
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

    // The gallery's standard resolution applies to the streamed archive too,
    // not only the cached one (#858).
    const { standardBox: bulkBox } = await resolveEventDownloadPolicy(req.event);

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

        // Resize to the gallery's standard resolution (#858) and/or watermark.
        // This branch runs whenever the cached zip isn't usable — the first
        // download after an invalidation, PIN clients, and galleries with
        // hidden photos all land here, so skipping the cap would leak
        // full-resolution files for exactly those cases.
        const rendered = await renderPhotoForDownload(req.event, photo, bulkBox, effectiveSettings);
        if (rendered) {
          archive.append(rendered, { name: archiveName });
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

    // Notification only after the response actually finished — finalize()
    // ends Archiver's input, not the HTTP transfer (codex review of #849,
    // confirmation round). Registered before finalize so it can't be missed.
    // Admin preview (#868) streams the archive but is excluded from stats.
    if (!req.isAdminPreview) {
      res.on('finish', () => {
        if (res.statusCode < 400) logActivity('gallery_downloaded', { scope: 'all' }, req.event.id, galleryActor(req));
      });
    }
    await archive.finalize();

    if (!req.isAdminPreview) {
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
    }
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to create download archive');
  }
});

// Download selected photos as ZIP
router.post('/:slug/download-selected', verifyGalleryAccess, denySlideshowToken, blockHiddenGallery, async (req, res) => {
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

    // Download resolution (#858). Resolve BEFORE any header goes out — once
    // the archive starts streaming we can no longer return a JSON error.
    const selectedPolicy = await resolveEventDownloadPolicy(req.event);
    const selectedResolution = pickRequestedResolution(selectedPolicy, req.body?.resolution);
    if (selectedResolution === null) {
      return res.status(400).json({ error: 'Resolution not available for this gallery' });
    }
    const selectedBox = parseResolution(selectedResolution);

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

        // Resize (#858) and/or watermark. renderPhotoForDownload returns null
        // when neither applies, so the untransformed case still streams from
        // storage rather than buffering the whole photo.
        const rendered = await renderPhotoForDownload(req.event, photo, selectedBox, effectiveSettings);
        if (rendered) {
          archive.append(rendered, { name });
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

    // See download-all: notify only on response 'finish'.
    // Admin preview (#868) streams the archive but is excluded from stats.
    if (!req.isAdminPreview) {
      res.on('finish', () => {
        if (res.statusCode < 400) logActivity('gallery_downloaded', { scope: 'selected', photo_count: photoIds.length }, req.event.id, galleryActor(req));
      });
    }
    await archive.finalize();

    if (!req.isAdminPreview) {
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
    }
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to download selected photos');
  }
});


// ──────────────────────────────────────────────────────────────────────────
// Custom-resolution download jobs (#858).
//
// The plain download-all is served from the pre-built cache at the gallery's
// STANDARD resolution. Picking a different size has nothing to cache against,
// and resizing a whole gallery inside one request would sit far past any
// reverse-proxy timeout — so those archives are built as a job the client
// polls. Same access rules as the download routes above.
// ──────────────────────────────────────────────────────────────────────────

// Kick off (or join) a build. Returns the polling token.
router.post('/:slug/download-jobs', verifyGalleryAccess, denySlideshowToken, blockHiddenGallery, async (req, res) => {
  try {
    if (!parseBooleanInput(req.event.allow_downloads, true)) {
      return res.status(403).json({ error: 'Downloads are disabled for this gallery' });
    }

    const policy = await resolveEventDownloadPolicy(req.event);
    if (!policy.pickerEnabled) {
      return res.status(403).json({ error: 'Resolution choice is not enabled for this gallery' });
    }
    const resolution = pickRequestedResolution(policy, req.body?.resolution);
    if (resolution === null) {
      return res.status(400).json({ error: 'Resolution not available for this gallery' });
    }

    // Optional subset. Absent = the whole visible gallery.
    let photoIds = null;
    if (Array.isArray(req.body?.photo_ids) && req.body.photo_ids.length) {
      photoIds = req.body.photo_ids
        .map((v) => parseInt(v, 10))
        .filter((v) => Number.isInteger(v))
        .slice(0, 500);
      if (photoIds.length === 0) {
        return res.status(400).json({ error: 'No valid photo IDs provided' });
      }
    }

    let job;
    try {
      job = await downloadJobService.createJob({
        event: req.event,
        resolution,
        photoIds,
        accessLevel: req.accessLevel,
      });
    } catch (err) {
      if (err.code === 'NO_PHOTOS') {
        return res.status(404).json({ error: 'No photos available for this selection' });
      }
      if (err.code === 'BUSY') {
        return res.status(429).json({ error: 'Too many downloads are being prepared right now — please try again shortly' });
      }
      throw err;
    }

    res.status(202).json({
      token: job.token,
      status: job.status,
      resolution: job.resolution,
    });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to start download preparation');
  }
});

// Poll. The token is unguessable, but it is never sufficient on its own —
// verifyGalleryAccess still runs and the job must belong to THIS event.
router.get('/:slug/download-jobs/:token', verifyGalleryAccess, denySlideshowToken, blockHiddenGallery, async (req, res) => {
  try {
    const job = await downloadJobService.getStatus(req.params.token);
    if (!job || job.event_id !== req.event.id) {
      return res.status(404).json({ error: 'Download job not found' });
    }
    res.json({
      status: job.status,
      resolution: job.resolution,
      photo_count: job.photo_count || 0,
      size_bytes: job.size_bytes || null,
      error: job.status === 'failed' ? (job.error || 'Preparation failed') : undefined,
    });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to read download job');
  }
});

// Deliver the finished archive.
router.get('/:slug/download-jobs/:token/file', verifyGalleryAccess, denySlideshowToken, blockHiddenGallery, async (req, res) => {
  try {
    // Downloads can be switched off after a job was created — every other
    // download route re-checks this per request, so this one must too.
    if (!parseBooleanInput(req.event.allow_downloads, true)) {
      return res.status(403).json({ error: 'Downloads are disabled for this gallery' });
    }

    const job = await downloadJobService.getStatus(req.params.token);
    if (!job || job.event_id !== req.event.id) {
      return res.status(404).json({ error: 'Download job not found' });
    }
    // The token alone never grants access: the archive was built under one
    // visibility scope, and only a requester still in that scope may take it.
    // Without this, a leaked client token would hand hidden photos to a guest.
    if (job.visibility_scope !== downloadJobService.visibilityScopeFor(req.accessLevel)) {
      return res.status(404).json({ error: 'Download job not found' });
    }
    if (job.status !== 'ready' || !job.zip_path) {
      return res.status(409).json({ error: 'Download is not ready yet', status: job.status });
    }
    if (new Date(job.expires_at).getTime() <= Date.now()) {
      return res.status(410).json({ error: 'This download has expired — please request it again' });
    }
    // A photo hidden AFTER this archive was built is still inside it, and the
    // scope check above can't see that — both sides remain 'public'. Re-run
    // the visibility query over the packaged set before handing it over.
    if (!(await downloadJobService.isStillDeliverable(job, req.event, req.accessLevel))) {
      return res.status(409).json({
        error: 'This gallery changed since the download was prepared — please request it again',
        status: 'stale',
      });
    }

    const storage = getStorage();
    const stat = await storage.stat(job.zip_path);
    if (!stat) {
      return res.status(410).json({ error: 'This download is no longer available' });
    }

    // Stats parity with the other bulk paths (#895): only count once the
    // response actually completed, and keep admin previews out of guest stats.
    res.on('finish', () => {
      if (res.statusCode >= 400 || req.isAdminPreview) return;
      // The DELIVERED set, not the requested one: a photo whose source was
      // missing at build time isn't in the zip and must not be counted.
      let ids = [];
      try {
        ids = JSON.parse(job.delivered_photo_ids || job.photo_ids || '[]');
      } catch (_) { /* malformed row — skip counting rather than fail */ }
      if (ids.length > 0) {
        db('photos').whereIn('id', ids).increment('download_count', 1).catch(() => {});
      }
      db('access_logs').insert({
        event_id: req.event.id,
        ip_address: req.ip,
        user_agent: req.headers['user-agent'],
        action: 'download',
        photo_id: null,
      }).catch(() => {});
      logActivity('gallery_downloaded', { scope: 'all', resolution: job.resolution },
        req.event.id, galleryActor(req));
    });

    const suffix = job.resolution === 'original' ? 'original' : job.resolution;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Content-Disposition', `attachment; filename="${req.event.slug}-${suffix}.zip"`);
    const stream = await storage.get(job.zip_path);
    stream.pipe(res);
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to serve prepared download');
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
  blockHiddenGallery,
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
      // Admin preview (#981 review) is excluded from per-photo view analytics.
      if (!req.isAdminPreview) {
        await db('photos').where('id', photo.id).increment('view_count', 1);
      }
      res.status(204).end();
    } catch (error) {
      errorResponse(res, error, 500, 'Failed to record view');
    }
  });

// View single photo (with watermark if enabled)
router.get('/:slug/photo/:photoId',
  verifyGalleryAccess,
  blockHiddenGallery,
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
          file.pipe(res);
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
          file.pipe(res);
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
                return wmStream.pipe(res);
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
          stream.pipe(res);
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
  blockHiddenGallery,
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
        stream.pipe(res);
      }
    } catch (error) {
      errorResponse(res, error, 500, 'Failed to serve thumbnail');
    }
  }
);

// Serve hero-optimized image (1920x1080 for full-width hero sections)
router.get('/:slug/hero/:photoId',
  verifyGalleryAccess,
  // Reveal-gated too: this route serves a 1920px derivative of ANY photo id,
  // not just the chosen hero — an open bypass while hidden (review round 1).
  blockHiddenGallery,
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
        return res.redirect(withPreview(req, `/api/gallery/${req.params.slug}/photo/${photoId}`));
      }

      // Ensure hero image exists and is valid, regenerate if needed
      const heroPath = await ensureHeroImage(photo);

      if (!heroPath) {
        // If hero generation fails, fall back to original photo
        logger.warn(`Failed to generate hero image for photo ${photoId}, falling back to original`);
        return res.redirect(withPreview(req, `/api/gallery/${req.params.slug}/photo/${photoId}`));
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
        return res.redirect(withPreview(req, `/api/gallery/${req.params.slug}/photo/${photoId}`));
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
        stream.pipe(res);
      }
    } catch (error) {
      logger.error('Error serving hero image:', {
        error: error.message,
        photoId: req.params.photoId,
        eventId: req.event?.id
      });
      // Fall back to original photo on any error
      res.redirect(withPreview(req, `/api/gallery/${req.params.slug}/photo/${req.params.photoId}`));
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
  blockHiddenGallery,
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
        return res.redirect(withPreview(req, `/api/gallery/${req.params.slug}/photo/${photoId}`));
      }

      // Lazy generation: ensurePreviewImage returns null on any
      // failure (corrupt source, sharp OOM, storage unavailable, …).
      // Fall back to the original so the lightbox always renders.
      const previewPath = await ensurePreviewImage(photo);
      if (!previewPath) {
        logger.warn(`Failed to generate preview for photo ${photoId}, falling back to original`);
        return res.redirect(withPreview(req, `/api/gallery/${req.params.slug}/photo/${photoId}`));
      }

      const storage = getStorage();
      const stat = await storage.stat(previewPath);
      if (!stat) {
        logger.error('Preview file does not exist in storage backend', {
          slug: req.params.slug, photoId, eventId: req.event.id, previewPath,
        });
        return res.redirect(withPreview(req, `/api/gallery/${req.params.slug}/photo/${photoId}`));
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
        'Content-Type': 'image/jpeg',
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
        const watermarkedBuffer = await withLocalCopy(previewPath, (localPath) =>
          watermarkService.applyWatermark(localPath, watermarkSettings)
        );
        res.send(watermarkedBuffer);
      } else {
        res.setHeader('Content-Length', stat.size);
        const stream = await storage.get(previewPath);
        stream.pipe(res);
      }
    } catch (error) {
      logger.error('Error serving preview image:', {
        error: error.message,
        photoId: req.params.photoId,
        eventId: req.event?.id,
      });
      res.redirect(withPreview(req, `/api/gallery/${req.params.slug}/photo/${req.params.photoId}`));
    }
  }
);

// GET /:slug/feedback-settings lives in galleryFeedback.js. A duplicate of it
// used to sit here, and since server.js mounts galleryRoutes before
// galleryFeedback it shadowed the real handler — dropping the per-guest caps
// (#655) from the guest payload, so the gallery could never render the
// favorite/like limits or their counters (#1030).

// Get photo stats
router.get('/:slug/stats', verifyGalleryAccess, blockHiddenGallery, async (req, res) => {
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
    const { getAllowedMimeTypes, getMaxFilesPerUpload, getMaxFileSizeBytes, DEFAULT_MAX_FILE_SIZE_MB } = require('../services/uploadSettings');
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

    // Per-file size cap was hardcoded to 50MB here, so the admin's Settings →
    // General → "Max File Size (MB)" value (general_max_file_size_mb) never
    // applied to guest uploads — a guest could not upload a large video even
    // when the admin allowed it (reported on #613 by mat1990dj). Resolve it from
    // settings like the count above; fall back to the 50MB default on read error.
    let maxFileSizeBytes;
    try {
      maxFileSizeBytes = await getMaxFileSizeBytes();
    } catch {
      maxFileSizeBytes = DEFAULT_MAX_FILE_SIZE_MB * 1024 * 1024;
    }

    const upload = multer({
      dest: tempUploadDir,
      limits: {
        fileSize: maxFileSizeBytes,
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
        // Turn multer's generic "File too large" into an actionable message
        // that names the configured limit.
        if (err.code === 'LIMIT_FILE_SIZE') {
          const limitMb = Math.floor(maxFileSizeBytes / (1024 * 1024));
          return res.status(400).json({ error: `File too large. Maximum size is ${limitMb} MB per file.` });
        }
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
