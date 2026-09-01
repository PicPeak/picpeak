/**
 * Migration 195 covers the three gallery-lifecycle mails migration 194 left
 * behind, and they turned out to be broken in two different ways:
 *
 *   - `expiration_warning` ships German-that-is-English on every fresh install
 *     (059 copies `_en` into `_de`, 075 materialises that as the `de` row, and
 *     the real German only ever lived in legacy migration 026).
 *   - `gallery_expired` / `archive_complete` are not seeded by any core
 *     migration at all, so a fresh install has no row for them and both mail
 *     paths fail with "Email template '<key>' not found".
 *
 * What is pinned here is as much about restraint as repair: the repair path may
 * only overwrite a German row that is still the English one, and the seed path
 * may only insert when the row is absent.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const migration = require('../../migrations/core/195_german_gallery_lifecycle_templates');

// The English copy of expiration_warning seeded by migration 001, verbatim.
const WARN_EN_SUBJECT = 'Your Photo Gallery Expires Soon';
const WARN_EN_HTML = `<h2>Gallery Expiring Soon</h2>
<p>Dear {{host_name}},</p>
<p>Your photo gallery "{{event_name}}" will expire in {{days_remaining}} days.</p>
<p>After expiration, the gallery will be archived and no longer accessible to guests.</p>
<p><a href="{{gallery_link}}">Visit Gallery</a></p>`;
const WARN_EN_TEXT = 'Gallery Expiring Soon\n\nDear {{host_name}},\n\nYour photo gallery "{{event_name}}" will expire in {{days_remaining}} days.';
const WARN_VARIABLES = ['host_name', 'event_name', 'days_remaining', 'gallery_link'];

// Captures both plain {{var}} tokens and the {{#if var}} / {{/if}} pair, so an
// unbalanced or renamed conditional shows up as a placeholder-set mismatch.
const placeholdersOf = (...parts) => {
  const found = new Set();
  for (const part of parts) {
    for (const match of String(part || '').matchAll(/\{\{\s*(#if\s+[\w.]+|\/if|[\w.]+)\s*\}\}/g)) {
      found.add(match[1].replace(/\s+/g, ' '));
    }
  }
  return [...found].sort();
};

describe('migration 195 — German + seeding for the remaining gallery-lifecycle mails', () => {
  let knex; let tmpDir;

  beforeAll(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'picpeak-mig195-'));
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
      t.string('category');
      t.string('subcategory');
      t.string('feature_flag');
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

  /**
   * The state a fresh install lands in: expiration_warning exists with the
   * English copy in BOTH the `_en` and `_de` columns (and both translation
   * rows); gallery_expired / archive_complete do not exist at all.
   */
  const seedFreshInstall = async ({ deHtml = WARN_EN_HTML, deSubject = WARN_EN_SUBJECT, deText = WARN_EN_TEXT } = {}) => {
    const [id] = await knex('email_templates').insert({
      template_key: 'expiration_warning',
      subject_en: WARN_EN_SUBJECT,
      subject_de: deSubject,
      body_html_en: WARN_EN_HTML,
      body_html_de: deHtml,
      body_text_en: WARN_EN_TEXT,
      body_text_de: deText,
      variables: JSON.stringify(WARN_VARIABLES),
      category: 'core',
      subcategory: 'gallery',
    });
    await knex('email_template_translations').insert([
      { template_id: id, language: 'en', subject: WARN_EN_SUBJECT, body_html: WARN_EN_HTML, body_text: WARN_EN_TEXT },
      { template_id: id, language: 'de', subject: deSubject, body_html: deHtml, body_text: deText },
    ]);
    return id;
  };

  const rowFor = async (templateId, language) =>
    knex('email_template_translations').where({ template_id: templateId, language }).first();

  const masterFor = async (templateKey) =>
    knex('email_templates').where({ template_key: templateKey }).first();

  const translationsFor = async (templateKey) => {
    const master = await masterFor(templateKey);
    return knex('email_template_translations').where({ template_id: master.id });
  };

  beforeEach(async () => {
    await dropTables();
    await createTables();
  });

  describe('expiration_warning — repair', () => {
    it('replaces the English-as-German row with actual German', async () => {
      const id = await seedFreshInstall();

      await migration.up(knex);

      const de = await rowFor(id, 'de');
      expect(de.subject).not.toBe(WARN_EN_SUBJECT);
      expect(de.body_html).not.toBe(WARN_EN_HTML);
      expect(de.body_text).not.toBe(WARN_EN_TEXT);
      expect(de.subject).toContain('Fotogalerie');
      expect(de.body_html).toContain('Galerie läuft bald ab');
      expect(de.body_text).toContain('Tagen ab');
      // The English row is not collateral damage.
      expect((await rowFor(id, 'en')).body_html).toBe(WARN_EN_HTML);
    });

    it('uses exactly the placeholder set of the English original', async () => {
      const id = await seedFreshInstall();

      await migration.up(knex);

      const en = await rowFor(id, 'en');
      const de = await rowFor(id, 'de');
      const expected = placeholdersOf(en.subject, en.body_html, en.body_text);
      expect(expected).toEqual(['days_remaining', 'event_name', 'gallery_link', 'host_name']);
      expect(placeholdersOf(de.subject, de.body_html, de.body_text)).toEqual(expected);
      // ...which is also the template's declared `variables` array.
      expect(expected).toEqual([...WARN_VARIABLES].sort());
    });

    it('repairs the legacy _de columns too', async () => {
      await seedFreshInstall();

      await migration.up(knex);

      const master = await masterFor('expiration_warning');
      expect(master.body_html_de).not.toBe(WARN_EN_HTML);
      expect(master.body_html_de).toContain('Galerie läuft bald ab');
      expect(master.subject_de).not.toBe(WARN_EN_SUBJECT);
      expect(master.body_html_en).toBe(WARN_EN_HTML);
    });

    it('leaves an already-translated German row (and columns) alone', async () => {
      // What a legacy install carries after legacy migration 026.
      const legacyDe = '<h2>Galerie läuft bald ab</h2><p>Liebe(r) {{host_name}},</p>';
      const id = await seedFreshInstall({
        deSubject: 'Ihre Fotogalerie läuft bald ab',
        deHtml: legacyDe,
        deText: 'Galerie läuft bald ab',
      });

      await migration.up(knex);

      expect((await rowFor(id, 'de')).body_html).toBe(legacyDe);
      expect((await masterFor('expiration_warning')).body_html_de).toBe(legacyDe);
    });

    it('fills in a missing German row', async () => {
      const id = await seedFreshInstall();
      await knex('email_template_translations').where({ template_id: id, language: 'de' }).del();

      await migration.up(knex);

      expect((await rowFor(id, 'de')).body_html).toContain('Galerie läuft bald ab');
    });
  });

  describe.each([
    ['gallery_expired', 'Galerie abgelaufen', 'Gallery Expired'],
    ['archive_complete', 'Archivierung abgeschlossen', 'Archive Complete'],
  ])('%s — seed', (templateKey, germanMarker, englishMarker) => {
    it('inserts the master row a fresh install never got', async () => {
      await seedFreshInstall();

      await migration.up(knex);

      const master = await masterFor(templateKey);
      expect(master).toBeDefined();
      expect(master.category).toBe('core');
      expect(master.subcategory).toBe('gallery');
      expect(JSON.parse(master.variables)).toContain('event_name');
      expect(master.body_html_en).toContain(englishMarker);
      expect(master.body_html_de).toContain(germanMarker);
    });

    it('inserts en + de translations whose German differs from the English', async () => {
      await seedFreshInstall();

      await migration.up(knex);

      const rows = await translationsFor(templateKey);
      expect(rows.map((r) => r.language).sort()).toEqual(['de', 'en']);
      const en = rows.find((r) => r.language === 'en');
      const de = rows.find((r) => r.language === 'de');
      expect(de.subject).not.toBe(en.subject);
      expect(de.body_html).not.toBe(en.body_html);
      expect(de.body_text).not.toBe(en.body_text);
      expect(de.body_html).toContain(germanMarker);
    });

    it('uses exactly the placeholder set of the English original', async () => {
      await seedFreshInstall();

      await migration.up(knex);

      const rows = await translationsFor(templateKey);
      const en = rows.find((r) => r.language === 'en');
      const de = rows.find((r) => r.language === 'de');
      const expected = placeholdersOf(en.subject, en.body_html, en.body_text);
      expect(placeholdersOf(de.subject, de.body_html, de.body_text)).toEqual(expected);
      // The support-contact line is conditional on both sides — getSupportEmail()
      // returns '' when nothing is configured, and an unbalanced {{#if}}/{{/if}}
      // would leave literal markup in the rendered mail.
      expect(expected).toContain('#if support_email');
      expect(expected).toContain('/if');
    });

    it('declares exactly the variables the send path fills', async () => {
      await seedFreshInstall();

      await migration.up(knex);

      const master = await masterFor(templateKey);
      const rows = await translationsFor(templateKey);
      const en = rows.find((r) => r.language === 'en');
      const used = placeholdersOf(en.subject, en.body_html, en.body_text)
        .filter((p) => !p.startsWith('#') && !p.startsWith('/'));
      expect(JSON.parse(master.variables).sort()).toEqual(used);
    });

    it('never overwrites an existing row', async () => {
      // What a legacy install carries: the row exists and legacy 026 already
      // gave it real German.
      await seedFreshInstall();
      const legacyDe = `<h2>${germanMarker}</h2><p>Liebe(r) {{host_name}},</p>`;
      const [id] = await knex('email_templates').insert({
        template_key: templateKey,
        subject_en: 'admin edited',
        subject_de: 'vom Admin bearbeitet',
        body_html_en: '<p>admin edited</p>',
        body_html_de: legacyDe,
        body_text_en: 'admin edited',
        body_text_de: 'vom Admin bearbeitet',
        variables: JSON.stringify(['event_name']),
      });
      await knex('email_template_translations').insert([
        { template_id: id, language: 'en', subject: 'admin edited', body_html: '<p>admin edited</p>', body_text: 'admin edited' },
        { template_id: id, language: 'de', subject: 'vom Admin bearbeitet', body_html: legacyDe, body_text: 'vom Admin bearbeitet' },
      ]);

      await migration.up(knex);

      const master = await masterFor(templateKey);
      expect(master.body_html_en).toBe('<p>admin edited</p>');
      expect(master.body_html_de).toBe(legacyDe);
      const rows = await translationsFor(templateKey);
      expect(rows.find((r) => r.language === 'en').body_html).toBe('<p>admin edited</p>');
      expect(rows.find((r) => r.language === 'de').body_html).toBe(legacyDe);
    });
  });

  it('is idempotent', async () => {
    const id = await seedFreshInstall();

    await migration.up(knex);
    const onceDe = await rowFor(id, 'de');
    const onceRows = await knex('email_template_translations').select('*').orderBy('id');
    await migration.up(knex);
    const twiceDe = await rowFor(id, 'de');
    const twiceRows = await knex('email_template_translations').select('*').orderBy('id');

    expect(twiceDe.body_html).toBe(onceDe.body_html);
    expect(twiceRows.length).toBe(onceRows.length);
    expect(await knex('email_templates').count('* as c'))
      .toEqual([{ c: 3 }]);
  });

  it('skips the repair when the template is absent, and no-ops without the tables', async () => {
    // No expiration_warning row at all — the repair must not throw, and the two
    // seeded templates still land.
    await expect(migration.up(knex)).resolves.toBeUndefined();
    expect(await masterFor('expiration_warning')).toBeUndefined();
    expect(await masterFor('gallery_expired')).toBeDefined();

    await dropTables();
    await expect(migration.up(knex)).resolves.toBeUndefined();
    await createTables();
  });
});
