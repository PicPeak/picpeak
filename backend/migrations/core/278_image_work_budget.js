exports.up = async function(knex) {
  // Bounded automatic retries for queued photos: the claim counter, and the
  // earliest time a photo put back after a transient image-worker refusal is
  // due again. Written and compared as ISO text, like processing_started_at.
  if (!(await knex.schema.hasColumn('photos', 'processing_attempts'))) {
    await knex.schema.alterTable('photos', table => table.integer('processing_attempts').notNullable().defaultTo(0));
  }
  if (!(await knex.schema.hasColumn('photos', 'processing_retry_at'))) {
    await knex.schema.alterTable('photos', table => table.timestamp('processing_retry_at').nullable());
  }
};
exports.down = async function(knex) {
  for (const column of ['processing_retry_at', 'processing_attempts']) {
    if (await knex.schema.hasColumn('photos', column)) {
      await knex.schema.alterTable('photos', table => table.dropColumn(column));
    }
  }
};
