/**
 * Make "not the same person" survive a re-scan (#1132).
 *
 * A separation — an explicit dismissal, or the implicit one a Split records —
 * was stored as a pair of `event_people.id`. Those ids do not survive
 * re-derivation, and the two paths differ in an important way:
 *
 *   - `recluster()` deletes every person and re-assigns, so person ids die but
 *     `photo_faces.id` survives.
 *   - a full re-scan replaces a photo's faces entirely
 *     (`processPhotoFaces` deletes and re-inserts), so FACE ids die too.
 *
 * So neither person ids nor face ids are stable enough. The only thing that
 * survives both is the embedding: the same photo through the same model
 * produces the same vector. The separation is therefore keyed on the two
 * CENTROIDS the pair had when the photographer separated them.
 *
 * That also answers the question the issue left open — what a separation means
 * once its two sides have been split further or merged with a third cluster.
 * It applies while both sides still LOOK like the clusters that were separated,
 * and stops applying once they have drifted past recognition. A constraint on a
 * pair that no longer exists should lapse, and this makes that automatic rather
 * than a rule someone has to write.
 *
 * The person ids stay as a fast exact path within one clustering cycle. They
 * are cheaper and unambiguous while they are still valid; the vectors are what
 * carries the decision across a re-derivation.
 *
 * Backfill takes each row's current person centroids. A row whose people are
 * already gone is dropped — it was dangling, and there is nothing to preserve.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('event_people_merge_dismissals'))) return;

  // Each column guarded on its own. SQLite runs migrations outside a
  // transaction and knex emits one ALTER per column, so a run that dies after
  // the first would leave the table half-built — and a guard keyed on
  // centroid_a alone would then skip the other two forever, with the backfill
  // below failing on every retry. Not recoverable without hand-editing the
  // schema, which is not something a deployment should ever need.
  const addColumn = async (name, build) => {
    if (await knex.schema.hasColumn('event_people_merge_dismissals', name)) return;
    await knex.schema.alterTable('event_people_merge_dismissals', build);
  };

  await addColumn('centroid_a', (table) => table.binary('centroid_a'));
  await addColumn('centroid_b', (table) => table.binary('centroid_b'));
  // Which embedding space the vectors live in. A model change makes them
  // meaningless rather than merely stale, exactly as it does for
  // event_people.centroid.
  await addColumn('model_version', (table) => table.string('model_version', 64));

  // Backfill from the people the rows point at, while they still resolve.
  const rows = await knex('event_people_merge_dismissals')
    .whereNull('centroid_a')
    .select('id', 'event_id', 'person_a_id', 'person_b_id');
  if (!rows.length) return;

  let filled = 0;
  let dropped = 0;
  for (const row of rows) {
    const people = await knex('event_people')
      .whereIn('id', [row.person_a_id, row.person_b_id])
      .select('id', 'centroid', 'model_version');
    const a = people.find((p) => p.id === row.person_a_id);
    const b = people.find((p) => p.id === row.person_b_id);

    if (!a?.centroid || !b?.centroid) {
      // Dangling already — the pair it named is gone, so there is no decision
      // left to carry forward.
      await knex('event_people_merge_dismissals').where({ id: row.id }).del();
      dropped += 1;
      continue;
    }

    await knex('event_people_merge_dismissals').where({ id: row.id }).update({
      centroid_a: a.centroid,
      centroid_b: b.centroid,
      model_version: a.model_version || b.model_version || null,
    });
    filled += 1;
  }

  console.log(`  184: keyed ${filled} separation(s) on embeddings, dropped ${dropped} dangling`);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('event_people_merge_dismissals'))) return;
  // Dropped one at a time for the same reason they are added one at a time.
  for (const name of ['centroid_a', 'centroid_b', 'model_version']) {
    if (!(await knex.schema.hasColumn('event_people_merge_dismissals', name))) continue;
    await knex.schema.alterTable('event_people_merge_dismissals', (table) => {
      table.dropColumn(name);
    });
  }
};
