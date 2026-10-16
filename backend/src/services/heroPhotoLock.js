/**
 * Deleting a photo that is a gallery's hero also updates that gallery's
 * event row: events.hero_photo_id references photos ON DELETE SET NULL, and
 * PostgreSQL runs that update after it has locked the photo. A rename, an
 * event face purge, a capped trash restore or an archive delete holds the
 * event row before it touches the photos, so the two could wait for each
 * other (issue 2108).
 *
 * Called inside the deleting transaction before the delete: takes those event
 * rows first, in the mode the foreign-key action takes them (NO KEY UPDATE).
 * Nothing on SQLite, which serialises writers.
 */
async function lockHeroEvents(trx, photoIds) {
  if (trx.client.config.client !== 'pg' || !photoIds.length) return;
  await trx('events').whereIn('hero_photo_id', photoIds).orderBy('id').forNoKeyUpdate().pluck('id');
}

module.exports = { lockHeroEvents };
