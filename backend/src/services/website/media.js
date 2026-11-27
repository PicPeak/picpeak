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
const { isAwaitingPayment, isGalleryAvailable, requiresGalleryPassword, isTrue } = require('../../utils/galleryLifecycle');
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

// The photo columns that change when its picture does: a replacement writes
// a new path and hash (photoReplacementService), an external source a new
// size or mtime, the EXIF refresh a new rendition_version.
const PHOTO_VERSION_COLUMNS = ['photos.path', 'photos.content_sha256', 'photos.size_bytes', 'photos.source_mtime_ms', 'photos.rendition_version'];

/** A short tag of a photo's content: it goes into the URL (see mediaBase). */
function photoVersion(photo) {
  const parts = ['path', 'content_sha256', 'size_bytes', 'source_mtime_ms', 'rendition_version']
    .map((column) => (photo[column] == null ? '' : String(photo[column])));
  return crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 10);
}

/**
 * Path prefix of one image; the renderer appends `/<width>`. A photo's URL
 * carries its content version (`p<id>-<version>`): the rendition is cached
 * publicly for a day, so a photo replaced under the same id needs a new URL.
 * The signature covers kind and id only; the version is not a secret.
 * Uploads never change in place (a new upload is a new id).
 */
function mediaBase(ref, version) {
  const kind = ref.source === 'photo' ? 'p' : 'a';
  const tag = kind === 'p' && version ? `-${version}` : '';
  return `/site-media/${kind}${ref.id}${tag}.${signMedia(kind, ref.id)}`;
}

/**
 * Parse `<kind><id>[-<version>].<sig>` from the URL. Returns
 * { kind, id, version } when the signature matches, else null.
 */
function parseMediaToken(token) {
  const match = /^([pa])([0-9a-f]{24}|[1-9][0-9]{0,15})(?:-([0-9a-f]{10}))?\.([0-9a-f]{32})$/.exec(String(token || ''));
  if (!match) return null;
  const [, kind, rawId, version, signature] = match;
  if (version && kind !== 'p') return null;
  if (kind === 'p' && !/^[1-9][0-9]*$/.test(rawId)) return null;
  if (kind === 'a' && !/^[0-9a-f]{24}$/.test(rawId)) return null;
  const id = kind === 'p' ? Number(rawId) : rawId;
  if (!verifyMedia(kind, id, signature)) return null;
  return { kind, id, version: version || null };
}

/**
 * Whether a gallery may contribute to the public website. Fails closed: a
 * gallery has to be opted in, live (active, not archived, not a draft, not
 * expired, not paused), revealed, and not waiting for payment.
 *
 * A password does not exclude it. The opt-in is the owner's consent to show
 * the photos they pick; only picked photos (and the cover the owner chose)
 * get a URL, the rest of the gallery stays behind its password, and a
 * featured-gallery card links to the gallery, where the password applies.
 */
function isEventWebsiteEligible(event, now = new Date()) {
  return !!event
    && isTrue(event.show_on_website)
    && isGalleryAvailable(event)
    && !isGalleryHidden(event, now)
    && !isAwaitingPayment(event);
}

/** Why a gallery is not eligible, for the admin picker; null when it is. */
function eventIneligibleReason(event, now = new Date()) {
  if (!event) return 'missing';
  if (!isTrue(event.show_on_website)) return 'not_opted_in';
  if (!isGalleryAvailable(event)) return 'unavailable';
  if (isGalleryHidden(event, now)) return 'hidden';
  if (isAwaitingPayment(event)) return 'payment_lock';
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
    .select('photos.id', 'photos.event_id', 'photos.width', 'photos.height', ...PHOTO_VERSION_COLUMNS);
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
 * The picture of a featured-gallery card: the cover (hero_photo_id) when a
 * guest sees it, else, for a gallery without a password, its first photo. A
 * protected gallery without a cover gets no picture: its other photos are
 * not the owner's pick.
 */
async function loadCoverPhotos(events) {
  const covers = new Map();
  for (const event of events) {
    let photo = null;
    if (event.hero_photo_id) {
      photo = await guestPhotoQuery().where({ 'photos.id': event.hero_photo_id, 'photos.event_id': event.id })
        .first('photos.id', 'photos.event_id', 'photos.width', 'photos.height', ...PHOTO_VERSION_COLUMNS);
    }
    if (!photo && !requiresGalleryPassword(event)) {
      photo = await guestPhotoQuery().where('photos.event_id', event.id).orderBy('photos.id', 'asc')
        .first('photos.id', 'photos.event_id', 'photos.width', 'photos.height', ...PHOTO_VERSION_COLUMNS);
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
  photoVersion,
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
