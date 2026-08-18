/**
 * Rule-based auto-categorisation from face counts (#1074 phase 3).
 *
 * Once faces are detected, `photos.face_count` and the landmark yaw are free
 * inputs for the sorting @bluecow94 asked for in discussion #1069. This is a
 * small rule list, not a classifier — the point is that it is predictable and
 * explainable, which a photographer can work with.
 *
 * THREE NON-NEGOTIABLE RULES, in order of importance:
 *
 *   1. It only ever fills an EMPTY category. It never overwrites a category
 *      a photographer set, because a human assignment is a decision and this
 *      is a heuristic. There is no configuration that changes this.
 *
 *   2. Everything it does is marked `auto_categorized = true`, so "undo all
 *      automatic categories" is one query rather than an archaeology
 *      exercise.
 *
 *   3. It is a separate step from detection and separately enableable. Some
 *      photographers want the sorting and not the people strip.
 */

const { db } = require('../database/db');
const logger = require('../utils/logger');
const { getThresholds } = require('./faceSettings');

/**
 * Category slugs this engine manages, in evaluation order. First match wins.
 *
 * `minFaceAreaRatio` on Portraits is what separates "a portrait of someone"
 * from "someone happens to be in this landscape" — one face in the frame
 * means nothing without knowing how much of the frame it occupies.
 */
const RULES = [
  {
    slug: 'details',
    name: 'Details',
    match: (photo) => photo.face_count === 0,
  },
  {
    slug: 'portraits',
    name: 'Portraits',
    match: (photo, ctx) => photo.face_count === 1 && ctx.largestFaceAreaRatio >= 0.08,
  },
  {
    slug: 'small-groups',
    name: 'Small groups',
    match: (photo) => photo.face_count >= 2 && photo.face_count <= 5,
  },
  {
    slug: 'groups',
    name: 'Groups',
    match: (photo) => photo.face_count > 5,
  },
];

/**
 * Find or create the event-scoped category for a rule.
 *
 * Event-scoped rather than global: these are generated categories, and
 * polluting every gallery's category list with them would be worse than the
 * duplication. An existing GLOBAL category with the same slug is reused when
 * present, so an operator who already has "Portraits" keeps one.
 */
async function resolveCategory(eventId, rule, cache, trx = db) {
  if (cache.has(rule.slug)) return cache.get(rule.slug);

  let category = await trx('photo_categories')
    .where('slug', rule.slug)
    .where(function () {
      this.where('event_id', eventId).orWhere('is_global', true);
    })
    .first();

  if (!category) {
    const [inserted] = await trx('photo_categories').insert({
      name: rule.name,
      slug: rule.slug,
      is_global: false,
      event_id: eventId,
      created_at: new Date().toISOString(),
    }).returning('id');
    const id = typeof inserted === 'object' ? inserted.id : inserted;
    category = { id, slug: rule.slug };
  }

  cache.set(rule.slug, category);
  return category;
}

/**
 * Apply the rules to one event.
 *
 * Only touches photos that have been face-scanned (`face_status = 'done'`)
 * and have no category. Returns a per-slug tally.
 */
async function categorizeEvent(eventId) {
  const thresholds = await getThresholds();
  if (!thresholds.face_auto_categorize_enabled) {
    return { skipped: true, reason: 'disabled' };
  }

  const photos = await db('photos')
    .where({ event_id: eventId, face_status: 'done' })
    // Rule 1, enforced in the query rather than trusted to a later branch.
    .whereNull('category_id')
    .select('id', 'face_count', 'width', 'height');

  if (!photos.length) return { assigned: 0, byCategory: {} };

  // One query for every face box in the event, rather than one per photo.
  const faceRows = await db('photo_faces')
    .where({ event_id: eventId })
    .whereIn('photo_id', photos.map((p) => p.id))
    .select('photo_id', 'bbox_w', 'bbox_h');

  const largestByPhoto = new Map();
  for (const row of faceRows) {
    const area = (row.bbox_w || 0) * (row.bbox_h || 0);
    if (area > (largestByPhoto.get(row.photo_id) || 0)) {
      largestByPhoto.set(row.photo_id, area);
    }
  }

  const cache = new Map();
  const byCategory = {};
  let assigned = 0;

  for (const photo of photos) {
    const frameArea = (photo.width || 0) * (photo.height || 0);
    const ctx = {
      largestFaceAreaRatio: frameArea > 0
        ? (largestByPhoto.get(photo.id) || 0) / frameArea
        : 0,
    };

    const rule = RULES.find((r) => r.match(photo, ctx));
    if (!rule) continue;

    const category = await resolveCategory(eventId, rule, cache);

    // Guard the UPDATE on category_id still being NULL. Between the SELECT
    // above and here a photographer may have set one by hand, and their
    // choice wins — rule 1 is not a best-effort.
    const updated = await db('photos')
      .where({ id: photo.id })
      .whereNull('category_id')
      .update({ category_id: category.id, auto_categorized: true });

    if (updated > 0) {
      assigned += updated;
      byCategory[rule.slug] = (byCategory[rule.slug] || 0) + updated;
    }
  }

  logger.info(
    `faceAutoCategories: assigned ${assigned} photo(s) in event ${eventId} `
    + `(${Object.entries(byCategory).map(([k, v]) => `${k}=${v}`).join(', ') || 'none'})`
  );
  return { assigned, byCategory };
}

/**
 * Undo every automatic assignment for an event.
 *
 * Clears only rows this engine set — a photographer's own categories are
 * untouched, which is the entire reason `auto_categorized` exists.
 */
async function undoEvent(eventId) {
  const cleared = await db('photos')
    .where({ event_id: eventId, auto_categorized: true })
    .update({ category_id: null, auto_categorized: false });

  logger.info(`faceAutoCategories: cleared ${cleared} automatic category assignment(s) in event ${eventId}`);
  return { cleared };
}

module.exports = { RULES, categorizeEvent, undoEvent };
