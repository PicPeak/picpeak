/**
 * Migration 214: idempotency key for contract drafts created from the editor
 * (issue 1447).
 *
 * The editor sends the same Idempotency-Key on every retry of one "create
 * draft" save. Storing it on the contract, under a unique index, lets a retry
 * after a lost response, a timeout or a double submit return the draft that
 * key already created instead of minting a second one; the index also settles
 * two concurrent requests with the same key.
 *
 * Additive and idempotent: adds a nullable column and its unique index, each
 * guarded on its own, so it is safe to re-run. SQLite runs this without a
 * transaction, so a run interrupted after the column was added must still get
 * the index on the next run; without it concurrent retries could each create
 * a draft. Existing contracts keep NULL, and NULLs never collide under a
 * unique index on SQLite or Postgres.
 */
const INDEX_NAME = 'contracts_create_idempotency_key_unique';

exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('contracts'))) return;
  if (!(await knex.schema.hasColumn('contracts', 'create_idempotency_key'))) {
    await knex.schema.alterTable('contracts', (t) => {
      t.string('create_idempotency_key', 128).nullable();
    });
  }
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS ${INDEX_NAME} ON contracts (create_idempotency_key)`);
};

exports.down = async function (knex) {
  if (!(await knex.schema.hasTable('contracts'))) return;
  await knex.raw(`DROP INDEX IF EXISTS ${INDEX_NAME}`);
  if (await knex.schema.hasColumn('contracts', 'create_idempotency_key')) {
    await knex.schema.alterTable('contracts', (t) => {
      t.dropColumn('create_idempotency_key');
    });
  }
};
