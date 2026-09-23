/**
 * pg_indexes lists every schema. The index lookups must only see the current
 * one: a same-named index in another schema must neither answer for it nor
 * stop it being created. On CI each PostgreSQL suite migrates into its own
 * schema, so unscoped lookups also read indexes that a parallel suite is
 * dropping and fail with "could not open relation with OID".
 *
 * Runs only when PICPEAK_PG_TEST_URL points at a throwaway Postgres database.
 */
const knex = require('knex');
const { randomUUID } = require('crypto');

const PG_URL = process.env.PICPEAK_PG_TEST_URL;
const maybe = PG_URL ? describe : describe.skip;

maybe('pg_indexes lookups are scoped to the current schema', () => {
  let owner; let db; let here; let other;
  const { externalRelpathIndexExists, INDEX_NAME } = require('../../src/services/externalPhotoDedupe');
  const { createIndexIfNotExists } = require('../../migrations/helpers');

  beforeAll(async () => {
    here = `idx_here_${randomUUID().replace(/-/g, '')}`;
    other = `idx_other_${randomUUID().replace(/-/g, '')}`;
    owner = knex({ client: 'pg', connection: PG_URL });
    await owner.schema.createSchema(here);
    await owner.schema.createSchema(other);
    // The other schema holds both indexes under the names the lookups ask for.
    await owner.schema.withSchema(other).createTable('photos', (t) => {
      t.increments('id');
      t.integer('event_id');
      t.string('external_relpath');
    });
    await owner.raw(`CREATE UNIQUE INDEX ${INDEX_NAME} ON "${other}".photos (event_id, external_relpath)`);
    await owner.raw(`CREATE INDEX photos_event_idx ON "${other}".photos (event_id)`);
    await owner.schema.withSchema(here).createTable('photos', (t) => {
      t.increments('id');
      t.integer('event_id');
      t.string('external_relpath');
    });
    db = knex({ client: 'pg', connection: PG_URL, searchPath: [here] });
  });

  afterAll(async () => {
    if (db) await db.destroy();
    if (owner) {
      await owner.schema.dropSchemaIfExists(here, true);
      await owner.schema.dropSchemaIfExists(other, true);
      await owner.destroy();
    }
  });

  it('does not report another schema\'s index as present here', async () => {
    expect(await externalRelpathIndexExists(db)).toBe(false);
  });

  it('creates an index here even when another schema has one of that name', async () => {
    await createIndexIfNotExists(db, 'photos', ['event_id'], 'photos_event_idx');
    const rows = await owner('pg_indexes').where({ schemaname: here, indexname: 'photos_event_idx' });
    expect(rows).toHaveLength(1);
  });
});
