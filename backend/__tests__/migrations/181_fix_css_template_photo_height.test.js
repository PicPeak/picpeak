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

  /**
   * The case that forced the scope wider. `sanitizeCSS` strips control
   * characters, so any template ever saved through the editor — including a
   * save that only changed its name — has had every newline REMOVED. An
   * exact-text migration finds nothing on those installs, is recorded as
   * applied, and leaves them broken permanently.
   */
  it('fixes a template that has been through the editor, newlines and all', async () => {
    const { sanitizeCSS } = require('../../src/utils/cssSanitizer');
    const { sanitized } = sanitizeCSS(ELEGANT_DARK);
    // Precondition: the sanitizer really did flatten it.
    expect(sanitized).not.toContain('\n');
    expect(sanitized).toContain('height: 200px');
    await knex('css_templates').insert({ name: 'Saved Once', css_content: sanitized });

    await migration.up(knex);

    const css = await contentOf('Saved Once');
    expect(css).not.toContain('200px');
    expect(css).toContain('height: 100%');
  });

  it('relaxes a user-authored fixed height too, but only on .photo-card img', async () => {
    // Deliberately broader than the seeded text — see the migration header. A
    // pixel height on the image cannot be right under any of the seven
    // layouts, whoever wrote it; a height anywhere else is none of our
    // business.
    const mine = '.photo-card img {\n  height: 220px;\n}\n.hero { height: 400px; }';
    await knex('css_templates').insert({ name: 'My Own', css_content: mine });

    await migration.up(knex);

    const css = await contentOf('My Own');
    expect(css).toContain('height: 100%');
    expect(css).not.toContain('220px');
    expect(css).toContain('.hero { height: 400px; }');
  });

  it('does not rewrite other properties that merely end in -height', async () => {
    // `line-height: 200px` contains `height: 200px` as a substring, so an
    // unanchored pattern silently rewrites it — in a migration that cannot be
    // undone.
    const mine = [
      '.photo-card img {',
      '  line-height: 200px;',
      '  max-height: 300px;',
      '  min-height: 14px;',
      '  --tile-height: 220px;',
      '  height: 200px;',
      '}',
    ].join('\n');
    await knex('css_templates').insert({ name: 'Adjacent Props', css_content: mine });

    await migration.up(knex);

    const css = await contentOf('Adjacent Props');
    expect(css).toContain('line-height: 200px');
    expect(css).toContain('max-height: 300px');
    expect(css).toContain('min-height: 14px');
    expect(css).toContain('--tile-height: 220px');
    // Only the real one moved.
    expect(css).toContain('height: 100%');
    expect(css).not.toMatch(/(?<![\w-])height:\s*200px/);
  });

  it('handles a grouped selector list', async () => {
    // Requiring `{` straight after `img` skipped these entirely — and the
    // migration is still recorded as applied, so the template kept the bug.
    const mine = '.photo-card img, .thumbnail img {\n  height: 200px;\n}';
    await knex('css_templates').insert({ name: 'Grouped', css_content: mine });

    await migration.up(knex);

    const css = await contentOf('Grouped');
    expect(css).toContain('.photo-card img, .thumbnail img {');
    expect(css).toContain('height: 100%');
    expect(css).not.toContain('200px');
  });

  it('skips a nested rule rather than rewriting the wrong declaration', async () => {
    // Valid nested CSS that passes the validator. A brace-greedy body would
    // capture the inner block and rewrite the CAPTION's height, which cannot
    // be undone. Leaving it untouched is the lesser evil.
    const mine = '.photo-card img {\n  & + .caption { height: 200px; }\n}';
    await knex('css_templates').insert({ name: 'Nested', css_content: mine });

    await migration.up(knex);

    expect(await contentOf('Nested')).toBe(mine);
  });

  it('leaves non-pixel heights on the image alone', async () => {
    const mine = '.photo-card img { height: 50vh; }\n.photo-card img { height: auto; }';
    await knex('css_templates').insert({ name: 'Relative', css_content: mine });

    await migration.up(knex);

    expect(await contentOf('Relative')).toBe(mine);
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
