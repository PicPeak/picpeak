/**
 * Which gallery a slug belongs to, counting the old slugs a rename leaves in
 * slug_redirects.
 *
 * A renamed gallery's old slug keeps answering: /gallery/<old-slug>/<token>
 * follows the redirect to the new slug. Handing that old slug to another
 * gallery broke those links, because the gallery lookup finds the new holder
 * first and the old gallery's token does not match it ("Invalid gallery
 * link"). So a slug is taken while a gallery holds it, or while it redirects
 * to a gallery that still exists. On SQLite the rows of a deleted gallery
 * stay behind (no foreign-key enforcement), and those free the slug again.
 */
const { db } = require('../database/db');

/**
 * The gallery holding `slug`, directly or through a redirect, other than
 * `exceptEventId`. Resolves to `{ id, event_name }` or null.
 */
async function findSlugHolder(slug, { exceptEventId = null, conn = db } = {}) {
  const direct = conn('events').where({ slug });
  if (exceptEventId !== null) direct.whereNot({ id: exceptEventId });
  const holder = await direct.first('id', 'event_name');
  if (holder) return holder;

  const viaRedirect = conn('slug_redirects as r')
    .join('events as e', 'e.slug', 'r.new_slug')
    .where('r.old_slug', slug);
  if (exceptEventId !== null) viaRedirect.whereNot('e.id', exceptEventId);
  return (await viaRedirect.first('e.id', 'e.event_name')) || null;
}

/**
 * The gallery a renamed gallery's old slug now leads to, or undefined. Only
 * the gallery the redirect was written for: a row left behind by a deleted
 * gallery (SQLite) must not lead to whichever gallery took its slug since.
 */
async function followSlugRedirect(slug) {
  const row = await db('slug_redirects').where({ old_slug: slug }).first('new_slug', 'event_id');
  if (!row || row.event_id === null) return undefined;
  return db('events').where({ id: row.event_id, slug: row.new_slug }).first();
}

module.exports = { findSlugHolder, followSlugRedirect };
