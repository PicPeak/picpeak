/**
 * Repairing stored CSS templates that carry remote url() references.
 *
 * The migration exists because the public render path (gallery.js, GET
 * /gallery/:slug/css) serves `css_templates.css_content` VERBATIM to
 * visitors — it does not re-sanitize on read. Fixing the sanitizer alone
 * would only protect newly-saved templates; rows already carrying a remote
 * URL would keep serving it forever.
 *
 * As with migration 181, most of what is pinned here is what it must NOT
 * touch: inline data: images, and stylesheets that were already clean.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const migration = require('../../migrations/core/200_strip_remote_urls_from_css_templates');

const WITH_REMOTE = `
.gallery-page {
  background: #111 url(https://tracker.example/pixel.gif) no-repeat;
  color: #eee;
}

.photo-card {
  border-radius: 12px;
}
`;

const WITH_DATA_URI = `
.photo-card {
  background-image: url(data:image/png;base64,iVBORw0KGgo=);
  border-radius: 8px;
}
`;

const ALREADY_CLEAN = `
.gallery-page {
  background: #fff;
  color: #222;
}
`;

// What the old, broken sanitizer actually left in the column.
const LEGACY_MARKER = '.a{background:/* BLOCKED URL */ url(https://tracker.example/pixel.gif)}';

describe('migration 200 — remote url() in CSS templates', () => {
  let knex; let tmpDir;

  beforeAll(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'picpeak-mig200-'));
    knex = require('knex')({
      client: 'sqlite3',
      connection: { filename: path.join(tmpDir, 'db.sqlite') },
      useNullAsDefault: true,
    });
    await knex.schema.createTable('css_templates', (t) => {
      t.increments('id').primary();
      t.integer('slot_number');
      t.string('name');
      t.text('css_content');
      t.timestamp('updated_at');
    });
    await knex.schema.createTable('activity_logs', (t) => {
      t.increments('id').primary();
      t.string('activity_type');
      t.string('actor_type');
      t.text('metadata');
      t.timestamp('created_at').defaultTo(knex.fn.now());
      t.timestamp('read_at');
    });
  });

  afterAll(async () => {
    if (knex) await knex.destroy();
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  beforeEach(async () => {
    await knex('css_templates').del();
    await knex('activity_logs').del();
  });

  const contentOf = async (name) =>
    (await knex('css_templates').where({ name }).first()).css_content;

  /** What a CSS parser sees — comments are discarded before parsing. */
  const asParsed = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

  it('removes a remote url() from a stored template', async () => {
    await knex('css_templates').insert({ slot_number: 1, name: 'Tracked', css_content: WITH_REMOTE });

    await migration.up(knex);

    const css = await contentOf('Tracked');
    expect(asParsed(css)).not.toContain('tracker.example');
    // The rest of the stylesheet survives.
    expect(css).toContain('#111');
    expect(css).toContain('border-radius: 12px');
  });

  it('repairs a row left behind by the old inert marker', async () => {
    // The exact shape the broken sanitizer wrote: a comment that a parser
    // discards, followed by the live URL.
    await knex('css_templates').insert({ slot_number: 2, name: 'Legacy', css_content: LEGACY_MARKER });

    await migration.up(knex);

    const css = await contentOf('Legacy');
    expect(asParsed(css)).not.toContain('tracker.example');
    expect(css).not.toContain('BLOCKED URL');
  });

  it('leaves an inline data: image alone', async () => {
    await knex('css_templates').insert({ slot_number: 3, name: 'Inline', css_content: WITH_DATA_URI });

    await migration.up(knex);

    expect(await contentOf('Inline')).toContain('data:image/png;base64,iVBORw0KGgo=');
  });

  it('does not touch a template that was already clean', async () => {
    await knex('css_templates').insert({ slot_number: 4, name: 'Clean', css_content: ALREADY_CLEAN });

    await migration.up(knex);

    expect(await contentOf('Clean')).toBe(ALREADY_CLEAN);
  });

  it('names every repaired slot in an activity log entry', async () => {
    await knex('css_templates').insert([
      { slot_number: 1, name: 'Tracked', css_content: WITH_REMOTE },
      { slot_number: 2, name: 'Legacy', css_content: LEGACY_MARKER },
      { slot_number: 3, name: 'Clean', css_content: ALREADY_CLEAN },
    ]);

    await migration.up(knex);

    const log = await knex('activity_logs')
      .where({ activity_type: 'css_template_remote_urls_removed' }).first();
    expect(log).toBeTruthy();
    const meta = JSON.parse(log.metadata);
    expect(meta.count).toBe(2);
    expect(meta.templates.map((t) => t.slot).sort()).toEqual([1, 2]);
    // Unread, so it surfaces in the admin notification bell.
    expect(log.read_at).toBeNull();
  });

  it('writes no notification when nothing needed repair', async () => {
    await knex('css_templates').insert({ slot_number: 1, name: 'Clean', css_content: ALREADY_CLEAN });

    await migration.up(knex);

    expect(await knex('activity_logs').count({ c: '*' })).toEqual([{ c: 0 }]);
  });

  it('is idempotent — a re-run changes nothing and adds no second notification', async () => {
    await knex('css_templates').insert({ slot_number: 1, name: 'Tracked', css_content: WITH_REMOTE });

    await migration.up(knex);
    const afterFirst = await contentOf('Tracked');
    await migration.up(knex);

    expect(await contentOf('Tracked')).toBe(afterFirst);
    expect(await knex('activity_logs').count({ c: '*' })).toEqual([{ c: 1 }]);
  });

  it('skips rows with no CSS at all', async () => {
    await knex('css_templates').insert({ slot_number: 5, name: 'Empty', css_content: null });

    await expect(migration.up(knex)).resolves.not.toThrow();
  });

  it('no-ops on an install with no css_templates table', async () => {
    const bare = require('knex')({
      client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true,
    });
    await expect(migration.up(bare)).resolves.not.toThrow();
    await bare.destroy();
  });

  it('down() is a deliberate no-op', async () => {
    await knex('css_templates').insert({ slot_number: 1, name: 'Tracked', css_content: WITH_REMOTE });
    await migration.up(knex);
    const repaired = await contentOf('Tracked');

    await migration.down(knex);

    // A rollback must not silently re-introduce third-party requests into
    // pages served to visitors.
    expect(await contentOf('Tracked')).toBe(repaired);
  });
});
