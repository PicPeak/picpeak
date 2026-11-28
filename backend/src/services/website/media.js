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
const { isAwaitingPayment, isGalleryAvailable, requiresGalleryPassword } = require('../../utils/galleryLifecycle');
const { isGalleryHidden } = require('../../utils/revealMode');
const { capsFullSizeView, MAXIMUM_PROTECTION_CAP } = require('../galleryAssetPolicy');
const { viewWatermarkSettings } = require('../galleryViewRendition');
const { AppError } = require('../../utils/errors');
const { ASSET_ID, ASSET_ID_PATTERN, flag } = require('./validators');
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
const VERSION_FIELDS = ['path', 'content_sha256', 'size_bytes', 'source_mtime_ms', 'rendition_version'];
const PHOTO_VERSION_COLUMNS = VERSION_FIELDS.map((column) => `photos.${column}`);

/**
 * A short tag of a photo's content and of how a guest sees it (`photo.view`,
 * see guestView): it goes into the URL (see mediaBase), so a changed
 * watermark is a new URL and no copy cached under the old one survives.
 */
function photoVersion(photo) {
  const parts = VERSION_FIELDS.map((column) => (photo[column] == null ? '' : String(photo[column])));
  parts.push(photo.view ? photo.view.tag : '');
  return crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 10);
}

/**
 * How the gallery shows its photos' view tiers to a guest, decided as the
 * gallery's preview route decides it: the watermark (the event's, or the
 * photo-sales mark in a priced gallery) and the maximum-protection cap. The
 * website serves exactly that, never less. `tag` names it for photoVersion.
 * Per gallery: the gallery decides the mark without looking at the photo.
 */
async function guestView(event) {
  const settings = await viewWatermarkSettings(event);
  // No settings: they could not be read (watermarkService logs why). The
  // gallery then shows the photo unmarked; the public website shows nothing.
  if (settings == null) throw new AppError('The watermark settings could not be read', 503, 'WEBSITE_WATERMARK_UNAVAILABLE');
  const watermark = settings && settings.enabled ? settings : null;
  const capped = capsFullSizeView(event);
  const mark = watermark ? crypto.createHash('sha1').update(JSON.stringify(watermark)).digest('hex').slice(0, 10) : '';
  return { watermark, capped, tag: `${mark}|${capped ? MAXIMUM_PROTECTION_CAP.tag : ''}` };
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
 * The editor's URL of a photo or an upload (picker tiles, field thumbnails,
 * the preview): `e<kind><id>-<expiry>.<sig>`, the expiry (unix seconds)
 * inside the signature, served `private, no-store`. It reaches what an
 * admin may pick, published or not, so it must never pass for a public URL:
 * its signature covers another kind (`ep` / `ea`) than the public one. The
 * expiry is the end of the next full hour, so a URL stays the same for an
 * hour and works for one to two.
 */
const EDITOR_URL_SECONDS = 3600;
function editorExpiry(now = Date.now()) {
  return (Math.floor(now / 1000 / EDITOR_URL_SECONDS) + 2) * EDITOR_URL_SECONDS;
}

function editorBase(ref, expires = editorExpiry()) {
  const kind = ref.source === 'photo' ? 'p' : 'a';
  return `/site-media/e${kind}${ref.id}-${expires}.${signMedia(`e${kind}`, `${ref.id}:${expires}`)}`;
}

/** The 640 tier of a photo for the editor. */
function photoPreviewUrl(photo) {
  return `${editorBase({ source: 'photo', id: photo.id })}/640`;
}

// A photo id or an asset id, then the version (public) or the expiry
// (editor), then the signature.
const MEDIA_ID = `(${ASSET_ID}|[1-9][0-9]{0,15})`;
const PUBLIC_TOKEN = new RegExp(`^([pa])${MEDIA_ID}(?:-([0-9a-f]{10}))?\\.([0-9a-f]{32})$`);
const EDITOR_TOKEN = new RegExp(`^e([pa])${MEDIA_ID}-([0-9]{10})\\.([0-9a-f]{32})$`);

/**
 * Parse `<kind><id>[-<version>].<sig>` (public) or
 * `e<kind><id>-<expiry>.<sig>` (editor) from the URL. Returns
 * { kind, id, version, editor } when the signature matches (and an editor
 * URL has not expired), else null.
 */
function parseMediaToken(token) {
  const editor = EDITOR_TOKEN.exec(String(token || ''));
  if (editor) {
    const [, kind, rawId, expires, signature] = editor;
    if (kind === 'p' && !/^[1-9][0-9]*$/.test(rawId)) return null;
    if (kind === 'a' && !ASSET_ID_PATTERN.test(rawId)) return null;
    if (!verifyMedia(`e${kind}`, `${rawId}:${expires}`, signature)) return null;
    if (Number(expires) * 1000 <= Date.now()) return null;
    return { kind, id: kind === 'p' ? Number(rawId) : rawId, version: null, editor: true };
  }
  const match = PUBLIC_TOKEN.exec(String(token || ''));
  if (!match) return null;
  const [, kind, rawId, version, signature] = match;
  if (version && kind !== 'p') return null;
  if (kind === 'p' && !/^[1-9][0-9]*$/.test(rawId)) return null;
  if (kind === 'a' && !ASSET_ID_PATTERN.test(rawId)) return null;
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
    && flag(event.show_on_website)
    && isGalleryAvailable(event)
    && !isGalleryHidden(event, now)
    && !isAwaitingPayment(event);
}

/** Why a gallery is not eligible, for the admin picker; null when it is. */
function eventIneligibleReason(event, now = new Date()) {
  if (!event) return 'missing';
  if (!flag(event.show_on_website)) return 'not_opted_in';
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
 * gallery that is not eligible is simply absent, so the renderer leaves it
 * out. `views: false` leaves out the guest view (no watermark settings
 * read): for callers that need which photos, not their URLs' versions.
 */
async function loadEligiblePhotos(photoIds, { views: withViews = true } = {}) {
  const ids = (photoIds || []).filter((id) => Number.isInteger(id) && id > 0);
  if (!ids.length) return new Map();
  const photos = await guestPhotoQuery().whereIn('photos.id', ids)
    .select('photos.id', 'photos.event_id', 'photos.width', 'photos.height', ...PHOTO_VERSION_COLUMNS);
  const events = await loadEligibleEvents([...new Set(photos.map((p) => p.event_id))]);
  // One view (one watermark settings read) per gallery, not per photo.
  const views = new Map();
  for (const event of events.values()) {
    // eslint-disable-next-line no-await-in-loop
    views.set(event.id, withViews ? await guestView(event) : null);
  }
  return new Map(photos.filter((p) => views.has(p.event_id)).map((p) => [p.id, { ...p, view: views.get(p.event_id) }]));
}

async function loadAssets(publicIds) {
  const ids = (publicIds || []).filter((id) => typeof id === 'string' && ASSET_ID_PATTERN.test(id));
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
async function loadCoverPhotos(events, { views: withViews = true } = {}) {
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
    if (photo) covers.set(event.id, { ...photo, view: withViews ? await guestView(event) : null });
  }
  return covers;
}

module.exports = {
  MEDIA_WIDTHS,
  mediaBase,
  editorBase,
  photoPreviewUrl,
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
