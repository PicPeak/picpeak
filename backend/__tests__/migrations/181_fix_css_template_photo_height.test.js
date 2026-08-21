/**
 * Repairing the bundled templates' fixed image height (#1131).
 *
 * The risk in a migration that rewrites user-visible CSS is doing too much,
 * so most of what is pinned here is what it must NOT touch: the other pixel
 * heights inside the very same templates (a 1px divider, an 8px scrollbar),
 * and any rule a user wrote themselves.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const migration = require('../../migrations/core/181_fix_css_template_photo_height');

const ELEGANT_DARK = `
.photo-card {
  border-radius: 12px;
}

.photo-card img {
  width: 100%;
  height: 200px;
  object-fit: cover;
  transition: transform 0.3s ease;
}
`;

const LIQUID_GLASS_DARK = `
.gallery-page::after {
  content: '';
  height: 1px;
  background: linear-gradient(90deg, transparent, #fff, transparent);
}

.photo-card img {
  width: 100%;
  height: 240px;
  object-fit: cover;
  filter: brightness(0.9);
}

.gallery-page ::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}

@media (max-width: 640px) {
  .photo-card img {
    height: 180px;
  }
}
`;

describe('migration 181 — CSS template image height (#1131)', () => {
  let knex; let tmpDir;

  beforeAll(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'picpeak-mig181-'));
    knex = require('knex')({
      client: 'sqlite3',
      connection: { filename: path.join(tmpDir, 'db.sqlite') },
      useNullAsDefault: true,
    });
    await knex.schema.createTable('css_templates', (t) => {
      t.increments('id').primary();
      t.string('name');
      t.text('css_content');
    });
  });

  afterAll(async () => {
    if (knex) await knex.destroy();
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  beforeEach(async () => { await knex('css_templates').del(); });

  const contentOf = async (name) =>
    (await knex('css_templates').where({ name }).first()).css_content;

  it('relaxes the default template so the layouts h-full can win', async () => {
    await knex('css_templates').insert({ name: 'Elegant Dark', css_content: ELEGANT_DARK });

    await migration.up(knex);

    const css = await contentOf('Elegant Dark');
    expect(css).toContain('height: 100%');
    expect(css).not.toContain('height: 200px');
    // Everything else about the rule survives.
    expect(css).toContain('object-fit: cover');
    expect(css).toContain('transition: transform 0.3s ease');
  });

  it('fixes both the base rule and the mobile override of the dark glass template', async () => {
    await knex('css_templates').insert({ name: 'Liquid Glass Dark', css_content: LIQUID_GLASS_DARK });

    await migration.up(knex);

    const css = await contentOf('Liquid Glass Dark');
    expect(css).not.toContain('height: 240px');
    expect(css).not.toContain('height: 180px');
    expect(css.match(/height: 100%/g)).toHaveLength(2);
  });

  it('leaves the divider and the scrollbar alone', async () => {
    await knex('css_templates').insert({ name: 'Liquid Glass Dark', css_content: LIQUID_GLASS_DARK });

    await migration.up(knex);

    // The whole reason this matches full rule bodies rather than every
    // `height: <n>px`: these are in the same stylesheet and are correct.
    const css = await contentOf('Liquid Glass Dark');
    expect(css).toContain('height: 1px');
    expect(css).toContain('width: 8px');
    expect(css).toContain('height: 8px');
  });

  it('does not touch a template the user wrote themselves', async () => {
    const mine = '.photo-card img {\n  height: 220px;\n}\n.hero { height: 400px; }';
    await knex('css_templates').insert({ name: 'My Own', css_content: mine });

    await migration.up(knex);

    expect(await contentOf('My Own')).toBe(mine);
  });

  it('is idempotent and safe on a row with no CSS', async () => {
    await knex('css_templates').insert([
      { name: 'Elegant Dark', css_content: ELEGANT_DARK },
      { name: 'Empty', css_content: null },
    ]);

    await migration.up(knex);
    const once = await contentOf('Elegant Dark');
    await migration.up(knex);

    expect(await contentOf('Elegant Dark')).toBe(once);
    expect(await contentOf('Empty')).toBeNull();
  });

  it('no-ops when the table does not exist yet', async () => {
    await knex.schema.dropTable('css_templates');
    await expect(migration.up(knex)).resolves.toBeUndefined();
    await knex.schema.createTable('css_templates', (t) => {
      t.increments('id').primary();
      t.string('name');
      t.text('css_content');
    });
  });
});
