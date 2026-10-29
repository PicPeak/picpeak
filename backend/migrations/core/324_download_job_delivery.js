// Existing prepared archives keep their delivery semantics until they expire.
exports.up = async function (knex) {
  for (const [column, add] of Object.entries({
    policy_version: (table) => table.integer('policy_version').notNullable().defaultTo(1),
    preview_only: (table) => table.boolean('preview_only').notNullable().defaultTo(false),
    entry_manifest: (table) => table.text('entry_manifest').nullable(),
  })) {
    if (!await knex.schema.hasColumn('download_jobs', column)) {
      await knex.schema.alterTable('download_jobs', add);
    }
  }
};

exports.down = async function (knex) {
  for (const column of ['entry_manifest', 'preview_only', 'policy_version']) {
    if (await knex.schema.hasColumn('download_jobs', column)) {
      await knex.schema.alterTable('download_jobs', (table) => table.dropColumn(column));
    }
  }
};
