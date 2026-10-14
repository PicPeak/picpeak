/**
 * Which gallery a slug belongs to, counting the old slugs a rename leaves in
 * slug_redirects.
 *
 * A renamed gallery's old slug keeps answering: /gallery/<old-slug>/<token>
 * follows the redirect to the new slug. Handing that old slug to another
 * gallery broke those links, because the gallery lookup finds the new holder
 * first and the old gallery's token does not match it ("Invalid gallery
 * link"). So a slug is taken while a gallery holds it, or while it redirects
 * to a slug a gallery holds. On SQLite the rows of a deleted gallery stay
 * behind (no foreign-key enforcement); they free the slug again unless
 * another gallery has since taken the slug they lead to. That costs such a
 * name a suffix; matching event_id as well would instead free the redirects
 * whose event_id a rename left on the wrong gallery before it was kept up to
 * date, and break their links.
 */
const { db } = require('../database/db');

/**
 * The gallery holding `slug`, directly or through a redirect, other than
 * `exceptEventId`. Resolves to `{ id, event_name }` or null.
 */
async function findSlugHolder(slug, { exceptEventId = null } = {}) {
  const direct = db('events').where({ slug });
  if (exceptEventId !== null) direct.whereNot({ id: exceptEventId });
  const holder = await direct.first('id', 'event_name');
  if (holder) return holder;

  const viaRedirect = db('slug_redirects as r')
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

/**
 * The first slug `makeSlug()` produces that no gallery holds, directly or
 * through a redirect. For slugs with a random part (quote and contract
 * conversion), where a clash is unlikely but must not hand another gallery's
 * old links to the new one or fail the insert.
 */
async function unusedSlug(makeSlug, { attempts = 10 } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    const slug = makeSlug();
    // eslint-disable-next-line no-await-in-loop
    if (!(await findSlugHolder(slug))) return slug;
  }
  throw new Error(`No free gallery slug after ${attempts} attempts`);
}

module.exports = { findSlugHolder, followSlugRedirect, unusedSlug };
