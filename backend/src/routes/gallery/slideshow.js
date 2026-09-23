const { isGalleryAvailable } = require('../../utils/galleryLifecycle');
const express = require('express');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { db } = require('../../database/db');
const { formatBoolean } = require('../../utils/dbCompat');

const router = express.Router();
const { noStoreCache } = require('../../middleware/noStoreCache');
const logger = require('../../utils/logger');
const { getEventShareToken, buildShareLinkVariants } = require('../../services/shareLinkService');
const { handleAsync } = require('../../utils/routeHelpers');
const { NotFoundError } = require('../../utils/errors');
const { setGalleryAuthCookies } = require('../../utils/tokenUtils');
const { getSlideshowGlobals } = require('../../utils/slideshowGlobals');
const { isFeatureEnabled } = require('../../middleware/requireFeatureFlag');

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
  if (!isGalleryAvailable(event)) return null;
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
// Centralised in utils/frontendUrl (#705) so the QR path and the public-origin
// resolver agree on what counts as a non-shareable base.
const QR_LOCAL_BASE_RE = { test: (v) => require('../../utils/frontendUrl').isLoopbackBase(v) };
const QR_ORIGIN_RE = /^https?:\/\/[^\s/]+$/i;
async function slideshowQrDataUrl(event, req) {
  try {
    const shareToken = getEventShareToken(event);
    if (!shareToken) return null;
    let { shareUrl, sharePath } = await buildShareLinkVariants({ slug: event.slug, shareToken });
    if (!/^https?:\/\//i.test(shareUrl) || QR_LOCAL_BASE_RE.test(shareUrl)) {
      // Prefer the kiosk's own window.location.origin (?origin=, validated):
      // req.get('host') is not reliably the browser origin: frontend/nginx.conf
      // forwards $http_host (port kept), but an outer proxy forwarding $host
      // strips a non-default port, so a deployment on :3000 behind one would
      // encode port 80. A LOOPBACK
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
// no-store: this response *is* a credential (it mints a gallery JWT and sets
// the per-slug auth cookie), so it must never be retained anywhere.
router.get('/:slug/show/:token/session', noStoreCache, handleAsync(async (req, res) => {
  const { slug, token } = req.params;
  const event = await resolveSlideshow(slug, token);
  if (!event) {
    throw new NotFoundError('Slideshow');
  }

  const sessionToken = jwt.sign({
    eventId: event.id,
    eventSlug: event.slug,
    type: 'gallery',
    // Unique per token: the revocation key falls back to eventId+iat otherwise,
    // so one guest's logout would revoke every same-second login (#1357).
    jti: crypto.randomUUID(),
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
router.get('/:slug/show/:token/state', noStoreCache, handleAsync(async (req, res) => {
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

// Get all photos.
//
// no-store (B6): the payload is private and per-guest — it carries the
// viewer's own likes/favorites/ratings and, for a client token, photos hidden
// from plain guests. With no Cache-Control at all a browser applies heuristic
// freshness and may reuse a body it stored on disk, on a shared device, for a
// gallery whose password has since been rotated. Express still computes its
// weak ETag, so a caller that does revalidate (React Query's own in-memory
// cache is unaffected either way) still gets a correct 304.

module.exports = router;
