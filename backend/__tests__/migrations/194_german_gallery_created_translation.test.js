/**
 * The `gallery_created` German translation shipped as the English text
 * verbatim on every fresh install (QA J.04), because 059 seeds `_de` from
 * `_en` and 075 turns those columns into the `de` translation row.
 *
 * What is pinned here is as much about restraint as repair: the migration may
 * only overwrite a German row that is still the English one, so a legacy
 * install (whose German came from legacy migration 026) and any template an
 * admin has edited themselves survive untouched.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const migration = require('../../migrations/core/194_german_gallery_created_translation');

// The English copy seeded by migration 001, verbatim.
const EN_SUBJECT = 'Your Photo Gallery is Ready!';
const EN_HTML = `<h2>Gallery Created Successfully</h2>
<p>Dear {{host_name}},</p>
<p>Your photo gallery "{{event_name}}" has been created successfully!</p>
<p><strong>Gallery Details:</strong></p>
<ul>
  <li>Event Date: {{event_date}}</li>
  <li>Gallery Link: {{gallery_link}}</li>
  <li>Password: {{gallery_password}}</li>
  <li>Expires: {{expiry_date}}</li>
</ul>
<p>Share this link and password with your guests to allow them to view and download photos.</p>`;
const EN_TEXT = 'Gallery Created Successfully\n\nDear {{host_name}},\n\nYour photo gallery "{{event_name}}" has been created successfully!';

const placeholdersOf = (...parts) => {
  const found = new Set();
  for (const part of parts) {
    for (const match of String(part || '').matchAll(/\{\{\s*([#/]?[\w.]+)\s*\}\}/g)) {
      found.add(match[1]);
    }
  }
  return [...found].sort();
};

describe('migration 194 — German gallery_created translation (QA J.04)', () => {
  let knex; let tmpDir;

  beforeAll(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'picpeak-mig194-'));
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

  const createTables = async () => {
    await knex.schema.createTable('email_templates', (t) => {
      t.increments('id').primary();
      t.string('template_key').unique().notNullable();
      t.string('subject_en');
      t.string('subject_de');
      t.text('body_html_en');
      t.text('body_html_de');
      t.text('body_text_en');
      t.text('body_text_de');
      t.json('variables');
      t.string('updated_at');
    });
    await knex.schema.createTable('email_template_translations', (t) => {
      t.increments('id').primary();
      t.integer('template_id');
      t.string('language', 10);
      t.text('subject');
      t.text('body_html');
      t.text('body_text');
      t.string('created_at');
      t.string('updated_at');
    });
  };

  const dropTables = async () => {
    if (await knex.schema.hasTable('email_template_translations')) {
      await knex.schema.dropTable('email_template_translations');
    }
    if (await knex.schema.hasTable('email_templates')) {
      await knex.schema.dropTable('email_templates');
    }
  };

  /** The state a fresh install lands in: 059 copied EN into the DE columns. */
  const seedFreshInstall = async ({ deHtml = EN_HTML, deSubject = EN_SUBJECT, deText = EN_TEXT } = {}) => {
    const [id] = await knex('email_templates').insert({
      template_key: 'gallery_created',
      subject_en: EN_SUBJECT,
      subject_de: deSubject,
      body_html_en: EN_HTML,
      body_html_de: deHtml,
      body_text_en: EN_TEXT,
      body_text_de: deText,
      variables: JSON.stringify(['host_name', 'event_name', 'event_date', 'gallery_link', 'gallery_password', 'expiry_date']),
    });
    await knex('email_template_translations').insert([
      { template_id: id, language: 'en', subject: EN_SUBJECT, body_html: EN_HTML, body_text: EN_TEXT },
      { template_id: id, language: 'de', subject: deSubject, body_html: deHtml, body_text: deText },
    ]);
    return id;
  };

  const rowFor = async (templateId, language) =>
    knex('email_template_translations').where({ template_id: templateId, language }).first();

  beforeEach(async () => {
    await dropTables();
    await createTables();
  });

  it('replaces the English-as-German row with actual German', async () => {
    const id = await seedFreshInstall();

    await migration.up(knex);

    const de = await rowFor(id, 'de');
    expect(de.subject).not.toBe(EN_SUBJECT);
    expect(de.body_html).not.toBe(EN_HTML);
    expect(de.body_text).not.toBe(EN_TEXT);
    expect(de.subject).toContain('Fotogalerie');
    expect(de.body_html).toContain('Galerie erfolgreich erstellt');
    expect(de.body_text).toContain('Passwort');
    // The English row is not collateral damage.
    const en = await rowFor(id, 'en');
    expect(en.body_html).toBe(EN_HTML);
  });

  it('uses exactly the placeholder set of the English original', async () => {
    const id = await seedFreshInstall();

    await migration.up(knex);

    const en = await rowFor(id, 'en');
    const de = await rowFor(id, 'de');
    const expected = placeholdersOf(en.subject, en.body_html, en.body_text);
    expect(expected).toEqual(['event_date', 'event_name', 'expiry_date', 'gallery_link', 'gallery_password', 'host_name']);
    expect(placeholdersOf(de.subject, de.body_html, de.body_text)).toEqual(expected);
  });

  it('repairs the legacy _de columns too', async () => {
    const id = await seedFreshInstall();

    await migration.up(knex);

    const master = await knex('email_templates').where({ id }).first();
    expect(master.body_html_de).not.toBe(EN_HTML);
    expect(master.body_html_de).toContain('Galerie erfolgreich erstellt');
    expect(master.subject_de).not.toBe(EN_SUBJECT);
    expect(master.body_html_en).toBe(EN_HTML);
  });

  it('leaves an already-translated German row (and columns) alone', async () => {
    // What a legacy install carries after legacy migration 026.
    const legacyDe = '<h2>Galerie erfolgreich erstellt</h2><p>Liebe(r) {{host_name}},</p>';
    const id = await seedFreshInstall({
      deSubject: 'Ihre Fotogalerie ist bereit!',
      deHtml: legacyDe,
      deText: 'Galerie erfolgreich erstellt',
    });

    await migration.up(knex);

    expect((await rowFor(id, 'de')).body_html).toBe(legacyDe);
    expect((await knex('email_templates').where({ id }).first()).body_html_de).toBe(legacyDe);
  });

  it('fills in a missing German row', async () => {
    const id = await seedFreshInstall();
    await knex('email_template_translations').where({ template_id: id, language: 'de' }).del();

    await migration.up(knex);

    expect((await rowFor(id, 'de')).body_html).toContain('Galerie erfolgreich erstellt');
  });

  it('is idempotent', async () => {
    const id = await seedFreshInstall();

    await migration.up(knex);
    const once = await rowFor(id, 'de');
    await migration.up(knex);
    const twice = await rowFor(id, 'de');

    expect(twice.body_html).toBe(once.body_html);
    expect(await knex('email_template_translations').where({ template_id: id, language: 'de' }).count())
      .toEqual([{ 'count(*)': 1 }]);
  });

  it('no-ops when the template or the tables are absent', async () => {
    await expect(migration.up(knex)).resolves.toBeUndefined();
    await dropTables();
    await expect(migration.up(knex)).resolves.toBeUndefined();
    await createTables();
  });
});
