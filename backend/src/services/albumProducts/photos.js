'use strict';
/**
 * Gallery photos a guided album names for fulfilment (issue 2320). A selection
 * holds the stable photo id and the filename for the studio's summary, never a
 * path or a URL: the picture itself keeps coming through the gallery's own
 * media routes and their authorisation.
 */
const { AppError } = require('../../utils/errors');
const {
  livePhotos,
  applyPhotoVisibilityFilter,
  wherePhotoProcessed,
  whereNotVideo,
} = require('../../utils/photoVisibility');

const MAX_PHOTO_ID = 2147483647;
const unavailable = () =>
  new AppError('A selected photo is no longer available; choose another one', 400, 'PHOTO_UNAVAILABLE');

/**
 * Photos of this gallery that can go into an album. 'guest' is the strictest
 * visibility rule on purpose: a PIN client can see a photo the studio hid, but
 * a hidden photo is not one to print. No trash, no held upload, nothing still
 * processing or missing, no video.
 */
function eligible(conn, eventId) {
  return whereNotVideo(
    wherePhotoProcessed(
      applyPhotoVisibilityFilter(livePhotos(conn).where('photos.event_id', eventId), 'guest'),
    ),
  ).whereNull('photos.moderation_status');
}

const countMessage = (key, { min, max }) =>
  `${key === 'cover' ? 'Cover photos' : 'Poster photos'}: choose ${min === max ? min : `${min} to ${max}`}`;

/** Validates a client's photo roles against the gallery and the studio's counts. */
async function select(conn, eventId, guided, input, { complete }) {
  const chosen = input ?? {};
  if (typeof chosen !== 'object' || Array.isArray(chosen))
    throw new AppError('Invalid photo selection', 400);
  if (Object.keys(chosen).some((key) => !guided.photoRoles.some((r) => r.key === key)))
    throw new AppError('Invalid photo selection', 400);
  const lists = guided.photoRoles.map((role) => {
    const ids = chosen[role.key] ?? [];
    if (
      !Array.isArray(ids) ||
      ids.some((id) => !Number.isInteger(id) || id < 1 || id > MAX_PHOTO_ID) ||
      new Set(ids).size !== ids.length
    )
      throw new AppError('Invalid photo selection', 400);
    if (ids.length > role.max || (complete && ids.length < role.min))
      throw new AppError(countMessage(role.key, role), 400, 'PHOTO_COUNT');
    return { key: role.key, ids };
  });
  const wanted = [...new Set(lists.flatMap((l) => l.ids))];
  const rows = wanted.length
    ? await eligible(conn, eventId)
      .whereIn('photos.id', wanted)
      .select('photos.id', 'photos.filename', 'photos.original_filename')
    : [];
  if (rows.length !== wanted.length) throw unavailable();
  const byId = new Map(rows.map((row) => [Number(row.id), row]));
  return lists.map(({ key, ids }) => ({
    key,
    photos: ids.map((id) => ({
      id,
      filename: byId.get(id).filename,
      originalFilename: byId.get(id).original_filename || null,
    })),
  }));
}

/** Marks photos that stopped being printable after they were chosen. */
async function withAvailability(conn, eventId, offers) {
  const ids = [
    ...new Set(
      offers.flatMap((o) => (o.selection?.photoRoles || []).flatMap((r) => r.photos.map((p) => p.id))),
    ),
  ];
  if (!ids.length) return offers;
  const live = new Set(
    (await eligible(conn, eventId).whereIn('photos.id', ids).select('photos.id')).map((r) => Number(r.id)),
  );
  return offers.map((offer) => {
    if (!offer.selection?.photoRoles) return offer;
    return {
      ...offer,
      selection: {
        ...offer.selection,
        photoRoles: offer.selection.photoRoles.map((role) => ({
          ...role,
          photos: role.photos.map((p) => ({ ...p, available: live.has(p.id) })),
        })),
      },
    };
  });
}

/** A client gets the reference to its own picture, not the studio's filenames. */
function forClient(selection) {
  if (!selection?.photoRoles) return selection;
  return {
    ...selection,
    photoRoles: selection.photoRoles.map((role) => ({
      key: role.key,
      photos: role.photos.map(({ id, available }) => ({ id, available })),
    })),
  };
}

module.exports = { select, withAvailability, forClient };
