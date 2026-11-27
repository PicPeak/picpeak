/**
 * Public images of the website builder (issue 2618).
 *
 * A website image is served at `/site-media/<kind><id>.<sig>/<width>`:
 *   - kind `p` is a gallery photo, `a` an image or video uploaded in the
 *     builder (website_assets.public_id);
 *   - sig is an HMAC of kind and id, so only URLs the renderer emitted work
 *     and the endpoint cannot be walked through photo ids;
 *   - width is one of the preview tiers. Only renditions are ever served,
 *     never an original, and a missing rendition is a 404, not a fallback.
 *
 * Eligibility is checked on every request, not only when a page is rendered:
 * turn a gallery's "show on website" off (or let it expire, archive it, give
 * it a password) and its photos stop loading at once, cached HTML or not.
 */
const crypto = require('crypto');
const { db } = require('../../database/db');
const { isGalleryAvailable, requiresGalleryPassword, isTrue } = require('../../utils/galleryLifecycle');
const { isGalleryHidden } = require('../../utils/revealMode');
const {
  applyPhotoVisibilityFilter, livePhotos, wherePhotoProcessed, whereNotVideo,
} = require('../../utils/photoVisibility');

const MEDIA_WIDTHS = [640, 1280, 1920];
const SIGNATURE_LENGTH = 32;

function mediaSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is required');
  return `website-media:${secret}`;
}

function signMedia(kind, id) {
  return crypto.createHmac('sha256', mediaSecret()).update(`${kind}:${id}`).digest('hex').slice(0, SIGNATURE_LENGTH);
}

function verifyMedia(kind, id, signature) {
  const candidate = String(signature || '');
  if (!/^[0-9a-f]{32}$/.test(candidate)) return false;
  return crypto.timingSafeEqual(Buffer.from(signMedia(kind, id)), Buffer.from(candidate));
}

/** Path prefix of one image; the renderer appends `/<width>`. */
function mediaBase(ref) {
  const kind = ref.source === 'photo' ? 'p' : 'a';
  return `/site-media/${kind}${ref.id}.${signMedia(kind, ref.id)}`;
}

/**
 * Parse `<kind><id>.<sig>` from the URL. Returns { kind, id } when the
 * signature matches, else null.
 */
function parseMediaToken(token) {
  const match = /^([pa])([0-9a-f]{24}|[1-9][0-9]{0,15})\.([0-9a-f]{32})$/.exec(String(token || ''));
  if (!match) return null;
  const [, kind, rawId, signature] = match;
  if (kind === 'p' && !/^[1-9][0-9]*$/.test(rawId)) return null;
  if (kind === 'a' && !/^[0-9a-f]{24}$/.test(rawId)) return null;
  const id = kind === 'p' ? Number(rawId) : rawId;
  if (!verifyMedia(kind, id, signature)) return null;
  return { kind, id };
}

/**
 * Whether a gallery may contribute to the public website. Fails closed: a
 * gallery has to be opted in, live (active, not archived, not a draft, not
 * expired, not paused), without a password, revealed, and not waiting for
 * payment. Password-protected galleries stay excluded even when opted in: the
 * password is the studio's statement that the gallery is not public.
 */
function isEventWebsiteEligible(event, now = new Date()) {
  return !!event
    && isTrue(event.show_on_website)
    && isGalleryAvailable(event)
    && !requiresGalleryPassword(event)
    && !isGalleryHidden(event, now)
    && !(isTrue(event.payment_lock) && !event.payment_unlocked_at);
}

/** Why a gallery is not eligible, for the admin picker; null when it is. */
function eventIneligibleReason(event, now = new Date()) {
  if (!event) return 'missing';
  if (!isTrue(event.show_on_website)) return 'not_opted_in';
  if (requiresGalleryPassword(event)) return 'password';
  if (!isGalleryAvailable(event)) return 'unavailable';
  if (isGalleryHidden(event, now)) return 'hidden';
  if (isTrue(event.payment_lock) && !event.payment_unlocked_at) return 'payment_lock';
  return null;
}

async function loadEligibleEvents(eventIds) {
  const ids = (eventIds || []).filter((id) => Number.isInteger(id) && id > 0);
  if (!ids.length) return new Map();
  const rows = await db('events').whereIn('id', ids);
  const now = new Date();
  return new Map(rows.filter((e) => isEventWebsiteEligible(e, now)).map((e) => [e.id, e]));
}

/** The photo rows a guest of the gallery would see: live, processed, visible, no video. */
function guestPhotoQuery() {
  return whereNotVideo(applyPhotoVisibilityFilter(wherePhotoProcessed(livePhotos(db)), 'guest'))
    .whereNull('photos.moderation_status');
}

/**
 * Photos by id that may appear on the public site, keyed by id. A photo of a
 * gallery that is not eligible is simply absent, so the renderer leaves it out.
 */
async function loadEligiblePhotos(photoIds) {
  const ids = (photoIds || []).filter((id) => Number.isInteger(id) && id > 0);
  if (!ids.length) return new Map();
  const photos = await guestPhotoQuery().whereIn('photos.id', ids)
    .select('photos.id', 'photos.event_id', 'photos.width', 'photos.height', 'photos.rendition_version');
  const events = await loadEligibleEvents([...new Set(photos.map((p) => p.event_id))]);
  return new Map(photos.filter((p) => events.has(p.event_id)).map((p) => [p.id, p]));
}

async function loadAssets(publicIds) {
  const ids = (publicIds || []).filter((id) => typeof id === 'string' && /^[0-9a-f]{24}$/.test(id));
  if (!ids.length) return new Map();
  const rows = await db('website_assets').whereIn('public_id', ids);
  return new Map(rows.map((row) => [row.public_id, row]));
}

function parseRenditionKeys(row) {
  try {
    const keys = typeof row.rendition_keys === 'string' ? JSON.parse(row.rendition_keys) : row.rendition_keys;
    return keys && typeof keys === 'object' ? keys : {};
  } catch {
    return {};
  }
}

/**
 * The first eligible photo per gallery, for a featured-gallery card without a
 * cover photo of its own: the cover (hero_photo_id) when a guest sees it,
 * else the gallery's first photo.
 */
async function loadCoverPhotos(events) {
  const covers = new Map();
  for (const event of events) {
    let photo = null;
    if (event.hero_photo_id) {
      photo = await guestPhotoQuery().where({ 'photos.id': event.hero_photo_id, 'photos.event_id': event.id })
        .first('photos.id', 'photos.event_id', 'photos.width', 'photos.height');
    }
    if (!photo) {
      photo = await guestPhotoQuery().where('photos.event_id', event.id).orderBy('photos.id', 'asc')
        .first('photos.id', 'photos.event_id', 'photos.width', 'photos.height');
    }
    if (photo) covers.set(event.id, photo);
  }
  return covers;
}

module.exports = {
  MEDIA_WIDTHS,
  signMedia,
  verifyMedia,
  mediaBase,
  parseMediaToken,
  isEventWebsiteEligible,
  eventIneligibleReason,
  loadEligibleEvents,
  loadEligiblePhotos,
  loadAssets,
  loadCoverPhotos,
  parseRenditionKeys,
  guestPhotoQuery,
};
