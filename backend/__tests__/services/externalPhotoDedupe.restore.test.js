/**
 * A pre-#1162 backup must still restore (#1162 review).
 *
 * `replaceAllTables` suspends FOREIGN KEY enforcement for the load — Postgres
 * via `session_replication_role = replica`, SQLite via `defer_foreign_keys` —
 * but neither of those suspends a UNIQUE index. An archive taken before
 * migration 186 carries exactly the duplicate photo rows that migration
 * removes, so the batchInsert would hit the new index and roll the entire
 * restore back, after every table had already been emptied.
 *
 * These pin the drop → load → dedupe → recreate sequence the restore now
 * performs, and the failure it exists to prevent.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const {
  dedupeExternalPhotos,
  createExternalRelpathIndex,
  dropExternalRelpathIndex,
} = require('../../src/services/externalPhotoDedupe');

describe('restoring an archive that predates the unique index (#1162)', () => {
  let knex; let tmpDir;

  // What a pre-186 archive's photos.ndjson holds for a racing import: the same
  // file twice, sub-millisecond apart.
  const ARCHIVE_ROWS = [
    { id: 1, event_id: 1, external_relpath: 'Trip/a.jpg', source_origin: 'external' },
    { id: 2, event_id: 1, external_relpath: 'Trip/a.jpg', source_origin: 'external' },
    { id: 3, event_id: 1, external_relpath: 'Trip/b.jpg', source_origin: 'external' },
  ];

  beforeAll(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'picpeak-restore-dedupe-'));
    knex = require('knex')({
      client: 'sqlite3',
      connection: { filename: path.join(tmpDir, 'db.sqlite') },
      useNullAsDefault: true,
    });
  });

  afterAll(async () => {
    if (knex) await knex.destroy();
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  beforeEach(async () => {
    await knex.schema.dropTableIfExists('photos');
    await knex.schema.createTable('photos', (t) => {
      t.integer('id').primary();
      t.integer('event_id');
      t.string('external_relpath');
      t.string('thumbnail_path');
      t.string('source_origin').defaultTo('managed');
    });
    await createExternalRelpathIndex(knex);
  });

  it('would abort the whole restore without the drop', async () => {
    // The regression, stated directly: this is what the target instance does
    // today when handed a legacy archive.
    await expect(knex.batchInsert('photos', ARCHIVE_ROWS, 100)).rejects.toThrow(/unique/i);
  });

  it('loads, dedupes and comes back constrained', async () => {
    await dropExternalRelpathIndex(knex);
    await knex.batchInsert('photos', ARCHIVE_ROWS, 100);

    const removed = await dedupeExternalPhotos(knex);
    await createExternalRelpathIndex(knex);

    expect(removed).toBe(1);
    expect((await knex('photos').orderBy('id')).map((r) => r.external_relpath))
      .toEqual(['Trip/a.jpg', 'Trip/b.jpg']);
    // The target must not be left unprotected by the restore that dropped it.
    await expect(
      knex('photos').insert({ id: 9, event_id: 1, external_relpath: 'Trip/b.jpg', source_origin: 'external' })
    ).rejects.toThrow(/unique/i);
  });

  it('is a no-op for an archive that has no duplicates', async () => {
    await dropExternalRelpathIndex(knex);
    await knex.batchInsert('photos', ARCHIVE_ROWS.slice(1), 100);

    expect(await dedupeExternalPhotos(knex)).toBe(0);
    await expect(createExternalRelpathIndex(knex)).resolves.toBeUndefined();
    expect(await knex('photos').count('* as c').first()).toEqual({ c: 2 });
  });
});
