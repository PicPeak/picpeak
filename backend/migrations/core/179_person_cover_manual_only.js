/**
 * event_people.cover_face_id now means one thing: the photographer picked this
 * face (#1096).
 *
 * It used to mean two things at once. `assignFaces` seeded it with whichever
 * face happened to open the cluster, and `recomputeCentroid` overwrote it with
 * the highest-scoring one — so the column held an automatic guess that was
 * indistinguishable from a deliberate choice. The moment the cover picker
 * started honouring it, every uncurated person would have had its avatar
 * pinned to that guess, which is worse than the score-ordered fallback it
 * replaced: the fallback is computed per audience and skips photos a guest
 * cannot open.
 *
 * Both writers are gone. The automatic cover is derived at read time in
 * facePeopleService.listPeople, where the visibility scoping already lives.
 *
 * Clearing every existing value is safe rather than destructive: no install has
 * ever been able to SET a cover deliberately — the UI for it ships in the same
 * change as this migration — so every stored value is an automatic guess by
 * construction. Keeping them would silently promote guesses to choices.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('event_people'))) return;
  if (!(await knex.schema.hasColumn('event_people', 'cover_face_id'))) return;

  await knex('event_people').update({ cover_face_id: null });
};

exports.down = async function down() {
  // Irreversible by design, and nothing is lost: the values this cleared were
  // derivable guesses, and listPeople regenerates that answer on every read.
  // Restoring them would mean re-inventing a number, not recovering one.
};
