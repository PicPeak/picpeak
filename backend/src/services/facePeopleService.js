/**
 * People queries for the gallery and admin surfaces (#1074).
 *
 * THE RULE THIS MODULE EXISTS TO ENFORCE: a guest's view of "who is in this
 * gallery" must be computed over the photos that guest can actually see.
 *
 * Guests are restricted to `photos.visibility = 'visible'` (gallery.js);
 * PIN-clients see everything. `event_people.face_count_total` counts ALL
 * faces, so handing it to a guest leaks the existence and volume of hidden
 * photos — and a cover face chosen from a hidden photo would render a crop of
 * an image the guest was never allowed to open. Neither is theoretical: a
 * photographer hides shots precisely because someone should not see them.
 *
 * So the guest-facing count and cover are recomputed per request against the
 * same predicate the photo query uses. `face_count_total` is never returned
 * to a guest.
 */

const { db } = require('../database/db');

/**
 * Apply the visibility predicate a given audience is allowed to see.
 * Mirrors gallery.js: guests get 'visible' (or NULL, pre-migration rows),
 * clients get everything. Also excludes photos still being processed, which
 * are invisible in the gallery payload too.
 */
function applyVisibilityScope(query, { isClient }) {
  query.where(function () {
    this.where('photos.processing_status', 'complete').orWhereNull('photos.processing_status');
  });
  if (!isClient) {
    query.where(function () {
      this.where('photos.visibility', 'visible').orWhereNull('photos.visibility');
    });
  }
  return query;
}

/**
 * People in an event, scoped to what this audience can see.
 *
 * Returns [{ id, label, face_count, cover: { photo_id, bbox } }] ordered by
 * visible photo count. People whose visible count falls below `minClusterSize`
 * are dropped — a person who appears in three hidden photos and one visible
 * one is not "in this gallery" from the guest's point of view.
 */
async function listPeople(eventId, { isClient = false, forAdmin = false, minClusterSize = 3 } = {}) {
  const people = await db('event_people')
    .where({ event_id: eventId })
    .modify((q) => {
      if (!forAdmin) {
        // Hidden = photographer-only. Ignored = bystander/false positive.
        // Neither ever reaches a guest response.
        q.where('is_hidden', false).where('is_ignored', false);
      }
    })
    .select('id', 'label', 'is_hidden', 'is_ignored', 'face_count_total', 'cover_face_id');

  if (!people.length) return [];

  // One grouped query for the audience-scoped counts, rather than N queries.
  const counts = await applyVisibilityScope(
    db('photo_faces')
      .join('photos', 'photos.id', 'photo_faces.photo_id')
      .where('photo_faces.event_id', eventId)
      .whereNotNull('photo_faces.person_id'),
    { isClient }
  )
    .groupBy('photo_faces.person_id')
    .select('photo_faces.person_id')
    .countDistinct({ visible_photos: 'photos.id' });

  const countByPerson = new Map(
    counts.map((r) => [r.person_id, Number(r.visible_photos) || 0])
  );

  // Cover faces, also scoped: the stored cover_face_id may point at a face in
  // a photo this audience cannot see. Pick the best VISIBLE face instead.
  const covers = await applyVisibilityScope(
    db('photo_faces')
      .join('photos', 'photos.id', 'photo_faces.photo_id')
      .where('photo_faces.event_id', eventId)
      .whereNotNull('photo_faces.person_id'),
    { isClient }
  )
    .orderBy('photo_faces.det_score', 'desc')
    .select(
      'photo_faces.id',
      'photo_faces.person_id',
      'photo_faces.photo_id',
      'photo_faces.bbox_x',
      'photo_faces.bbox_y',
      'photo_faces.bbox_w',
      'photo_faces.bbox_h',
      // The bbox is in ORIGINAL image pixels, so any consumer cropping it has
      // to know what those pixels were measured against. Without these the
      // admin manager was scaling an original-space box by a THUMBNAIL's
      // natural size and rendering the wrong region entirely.
      'photos.width as photo_width',
      'photos.height as photo_height'
    );

  const coverByPerson = new Map();
  for (const row of covers) {
    // Rows arrive best-score-first, so the first hit per person wins.
    if (!coverByPerson.has(row.person_id)) coverByPerson.set(row.person_id, row);
  }

  const out = [];
  for (const person of people) {
    const count = countByPerson.get(person.id) || 0;
    const cover = coverByPerson.get(person.id);

    // A person with no visible photos, or too few to be worth a face in the
    // strip, simply does not exist for this audience.
    if (!forAdmin && (count < minClusterSize || !cover)) continue;
    if (forAdmin && !cover && count === 0) {
      out.push({
        id: person.id,
        label: person.label || null,
        face_count: 0,
        total_face_count: person.face_count_total,
        is_hidden: !!person.is_hidden,
        is_ignored: !!person.is_ignored,
        cover: null,
      });
      continue;
    }

    const entry = {
      id: person.id,
      label: person.label || null,
      face_count: count,
      cover: cover
        ? {
          face_id: cover.id,
          photo_id: cover.photo_id,
          bbox: [cover.bbox_x, cover.bbox_y, cover.bbox_w, cover.bbox_h],
          photo_width: cover.photo_width ?? null,
          photo_height: cover.photo_height ?? null,
        }
        : null,
    };

    if (forAdmin) {
      // face_count_total is admin-only by design — see the module header.
      entry.total_face_count = person.face_count_total;
      entry.is_hidden = !!person.is_hidden;
      entry.is_ignored = !!person.is_ignored;
    }

    out.push(entry);
  }

  return out.sort((a, b) => b.face_count - a.face_count);
}

/**
 * Map of photoId → person ids, for the photos in `photoIds`.
 *
 * Only ever called with ids already present in the gallery payload, which is
 * itself visibility-filtered — so this cannot widen what a caller sees. It
 * still filters hidden/ignored people, so a hidden person leaves no trace on
 * a photo the guest CAN see.
 */
async function getPersonIdsByPhoto(eventId, photoIds, { forAdmin = false } = {}) {
  if (!photoIds?.length) return new Map();

  const rows = await db('photo_faces')
    .join('event_people', 'event_people.id', 'photo_faces.person_id')
    .where('photo_faces.event_id', eventId)
    .whereIn('photo_faces.photo_id', photoIds)
    .whereNotNull('photo_faces.person_id')
    .modify((q) => {
      if (!forAdmin) {
        q.where('event_people.is_hidden', false).where('event_people.is_ignored', false);
      }
    })
    .select('photo_faces.photo_id', 'photo_faces.person_id');

  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.photo_id)) map.set(row.photo_id, []);
    const list = map.get(row.photo_id);
    if (!list.includes(row.person_id)) list.push(row.person_id);
  }
  return map;
}

/**
 * Scan progress for the admin status line and the gallery's "Finding
 * people… 240/1200" indicator.
 */
async function getScanStatus(eventId, { isClient = true } = {}) {
  // `isClient` defaults to TRUE (the admin/photographer view) because every
  // existing caller is an admin surface. A guest must pass isClient:false:
  // counting every photo with a face_status would otherwise tell them how
  // many hidden photos the gallery holds — the same leak the people list and
  // covers are already scoped against, arriving through the progress bar.
  const rows = await applyVisibilityScope(
    db('photos').where({ event_id: eventId }).whereNotNull('face_status'),
    { isClient }
  )
    .groupBy('face_status')
    .select('face_status')
    .count({ c: '*' });

  const byStatus = Object.fromEntries(rows.map((r) => [r.face_status, Number(r.c) || 0]));
  const done = byStatus.done || 0;
  const total = Object.values(byStatus).reduce((a, b) => a + b, 0);

  const peopleRow = await db('event_people')
    .where({ event_id: eventId })
    .count({ c: '*' })
    .first();

  // Two counts, deliberately. `people` is every cluster that exists;
  // `people_visible_to_guests` applies the minimum-cluster-size floor and the
  // hidden/ignored flags, i.e. what the gallery strip actually shows. An
  // admin comparing the settings page against their own gallery will
  // otherwise see two numbers that disagree with no explanation.
  const { getThresholds } = require('./faceSettings');
  const thresholds = await getThresholds();
  const visible = await listPeople(eventId, {
    isClient: false,
    forAdmin: false,
    minClusterSize: thresholds.face_min_cluster_size,
  });

  return {
    scanned: done,
    total,
    pending: (byStatus.pending || 0) + (byStatus.processing || 0),
    failed: byStatus.failed || 0,
    skipped: byStatus.skipped || 0,
    people: Number(peopleRow?.c ?? 0),
    people_visible_to_guests: visible.length,
    in_progress: ((byStatus.pending || 0) + (byStatus.processing || 0)) > 0,
  };
}

module.exports = {
  listPeople,
  getPersonIdsByPhoto,
  getScanStatus,
  applyVisibilityScope,
};
