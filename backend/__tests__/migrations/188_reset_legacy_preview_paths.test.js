/**
 * Legacy preview keys must not survive the encoder change.
 *
 * The old generator kept the SOURCE basename verbatim while always writing
 * JPEG, so a `.webp` upload produced `preview_shot.webp` holding a JPEG. The
 * route now derives Content-Type from the key, and sets `nosniff` — so that
 * legacy object would be announced as image/webp and render as a broken image.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const migration = require('../../migrations/core/188_reset_legacy_preview_paths');

describe('migration 188 — legacy preview keys (#1166 follow-up)', () => {
  let knex; let tmpDir;

  beforeAll(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'picpeak-mig188-'));
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
      t.increments('id').primary();
      t.string('preview_path');
      t.string('thumbnail_path');
    });
  });

  it('clears the mislabelled .webp keys that would render broken', async () => {
    await knex('photos').insert({ preview_path: 'previews/preview_shot.webp' });

    await migration.up(knex);

    expect((await knex('photos').first()).preview_path).toBeNull();
  });

  it('clears .jpg keys too, because a byte-correct one can still be flattened', async () => {
    // A legacy .jpg key is valid JPEG, but it may be a flattened rendition of a
    // transparent or animated source, and nothing in the key says so. One lazy
    // regeneration is cheaper than reasoning about which of them lied.
    await knex('photos').insert([
      { preview_path: 'previews/preview_a.jpg' },
      { preview_path: 'previews/preview_b.png' },
    ]);

    await migration.up(knex);

    expect(await knex('photos').whereNotNull('preview_path').count('* as c').first()).toEqual({ c: 0 });
  });

  it('leaves thumbnails alone — they are a different cache', async () => {
    await knex('photos').insert({ preview_path: 'previews/p.jpg', thumbnail_path: 'thumbnails/t.jpg' });

    await migration.up(knex);

    expect((await knex('photos').first()).thumbnail_path).toBe('thumbnails/t.jpg');
  });

  it('is idempotent and safe with nothing to clear', async () => {
    await migration.up(knex);
    await expect(migration.up(knex)).resolves.toBeUndefined();
  });

  it('no-ops before 104 has added the column', async () => {
    await knex.schema.dropTableIfExists('photos');
    await knex.schema.createTable('photos', (t) => { t.increments('id').primary(); });

    await expect(migration.up(knex)).resolves.toBeUndefined();
  });
});
