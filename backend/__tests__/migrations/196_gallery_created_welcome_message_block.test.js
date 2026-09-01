/**
 * `welcome_message` is on the queued payload of every gallery_created mail
 * (adminEvents/crud.js:139) and nl/pt/ru/fr/es/sl all render it — but the
 * English copy seeded by migration 001 has no `{{#if welcome_message}}` block,
 * and migration 194's German was written against that English. So EN and DE
 * recipients silently lost the photographer's personal note to their client.
 *
 * The guard is byte-identity with the copy this codebase seeded: an
 * admin-edited body, and a legacy install whose EN/DE came from legacy 028/026
 * (both of which already carry a welcome_message block), must survive
 * untouched.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const migration = require('../../migrations/core/196_gallery_created_welcome_message_block');
const { safeTemplateReplace } = require('../../src/services/emailProcessor');

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

// The German copy written by migration 194, verbatim.
const DE_SUBJECT = 'Ihre Fotogalerie ist bereit!';
const DE_HTML = `<h2>Galerie erfolgreich erstellt</h2>
<p>Guten Tag {{host_name}},</p>
<p>Ihre Fotogalerie „{{event_name}}“ wurde erfolgreich erstellt!</p>
<p><strong>Details zur Galerie:</strong></p>
<ul>
  <li>Veranstaltungsdatum: {{event_date}}</li>
  <li>Link zur Galerie: <a href="{{gallery_link}}">{{gallery_link}}</a></li>
  <li>Passwort: {{gallery_password}}</li>
  <li>Verfügbar bis: {{expiry_date}}</li>
</ul>
<p>Teilen Sie diesen Link und das Passwort mit Ihren Gästen, damit diese die Fotos ansehen und herunterladen können.</p>`;
const DE_TEXT = 'Galerie erfolgreich erstellt\n\nGuten Tag {{host_name}},\n\nIhre Fotogalerie „{{event_name}}“ wurde erfolgreich erstellt!';

// The exact one-liner nl/pt/ru (075), fr (099), es (106) and sl (108) use.
const SIBLING_BLOCK = '{{#if welcome_message}}<p><em>{{welcome_message}}</em></p>{{/if}}';

const SEEDED_VARIABLES = ['host_name', 'event_name', 'event_date', 'gallery_link', 'gallery_password', 'expiry_date'];

const placeholdersOf = (...parts) => {
  const found = new Set();
  for (const part of parts) {
    for (const match of String(part || '').matchAll(/\{\{\s*(#if\s+[\w.]+|\/if|[\w.]+)\s*\}\}/g)) {
      found.add(match[1].replace(/\s+/g, ' '));
    }
  }
  return [...found].sort();
};

describe('migration 196 — {{#if welcome_message}} for the EN/DE gallery_created copy', () => {
  let knex; let tmpDir;

  beforeAll(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'picpeak-mig196-'));
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

  /** The state a fresh install lands in once migration 194 has run. */
  const seedPost194 = async ({ enHtml = EN_HTML, deHtml = DE_HTML, variables = SEEDED_VARIABLES } = {}) => {
    const [id] = await knex('email_templates').insert({
      template_key: 'gallery_created',
      subject_en: EN_SUBJECT,
      subject_de: DE_SUBJECT,
      body_html_en: enHtml,
      body_html_de: deHtml,
      body_text_en: EN_TEXT,
      body_text_de: DE_TEXT,
      variables: JSON.stringify(variables),
    });
    await knex('email_template_translations').insert([
      { template_id: id, language: 'en', subject: EN_SUBJECT, body_html: enHtml, body_text: EN_TEXT },
      { template_id: id, language: 'de', subject: DE_SUBJECT, body_html: deHtml, body_text: DE_TEXT },
      // A sibling locale that already had the block all along.
      { template_id: id, language: 'nl', subject: 'Uw fotogalerij is klaar!', body_html: `<p>Beste {{host_name}},</p>\n${SIBLING_BLOCK}`, body_text: 'Beste {{host_name}},' },
    ]);
    return id;
  };

  const rowFor = async (templateId, language) =>
    knex('email_template_translations').where({ template_id: templateId, language }).first();

  beforeEach(async () => {
    await dropTables();
    await createTables();
  });

  it('adds the block to the English and German bodies', async () => {
    const id = await seedPost194();

    await migration.up(knex);

    expect((await rowFor(id, 'en')).body_html).toBe(`${EN_HTML}\n${SIBLING_BLOCK}`);
    expect((await rowFor(id, 'de')).body_html).toBe(`${DE_HTML}\n${SIBLING_BLOCK}`);
  });

  it('uses the same block shape as the sibling locales', async () => {
    const id = await seedPost194();

    await migration.up(knex);

    const nl = await rowFor(id, 'nl');
    for (const language of ['en', 'de']) {
      const row = await rowFor(id, language);
      expect(row.body_html.endsWith(SIBLING_BLOCK)).toBe(true);
      expect(row.body_html).toContain(nl.body_html.split('\n').pop());
    }
  });

  it('keeps the German placeholder set identical to the English', async () => {
    const id = await seedPost194();

    await migration.up(knex);

    const en = await rowFor(id, 'en');
    const de = await rowFor(id, 'de');
    const expected = placeholdersOf(en.subject, en.body_html, en.body_text);
    expect(expected).toContain('welcome_message');
    expect(expected).toContain('#if welcome_message');
    expect(expected).toContain('/if');
    expect(placeholdersOf(de.subject, de.body_html, de.body_text)).toEqual(expected);
  });

  it('repairs the legacy _de/_en columns too, and declares the variable', async () => {
    const id = await seedPost194();

    await migration.up(knex);

    const master = await knex('email_templates').where({ id }).first();
    expect(master.body_html_en).toBe(`${EN_HTML}\n${SIBLING_BLOCK}`);
    expect(master.body_html_de).toBe(`${DE_HTML}\n${SIBLING_BLOCK}`);
    expect(JSON.parse(master.variables)).toEqual([...SEEDED_VARIABLES, 'welcome_message']);
  });

  it('leaves the plain-text bodies alone', async () => {
    // formatWelcomeMessage HTML-escapes and nl2br's the value once, for both
    // bodies — dropping it into the text part would print literal <br />.
    const id = await seedPost194();

    await migration.up(knex);

    expect((await rowFor(id, 'en')).body_text).toBe(EN_TEXT);
    expect((await rowFor(id, 'de')).body_text).toBe(DE_TEXT);
  });

  it('leaves an admin-edited body untouched', async () => {
    const edited = '<h2>Our own wording</h2><p>Hi {{host_name}}</p>';
    const id = await seedPost194({ enHtml: edited, deHtml: edited });

    await migration.up(knex);

    expect((await rowFor(id, 'en')).body_html).toBe(edited);
    expect((await rowFor(id, 'de')).body_html).toBe(edited);
    const master = await knex('email_templates').where({ id }).first();
    expect(master.body_html_en).toBe(edited);
    expect(master.body_html_de).toBe(edited);
  });

  it('leaves a legacy install (whose copy already has the block) untouched', async () => {
    const legacyEn = '<h2>Hello {{host_name}},</h2>\n{{#if welcome_message}}\n<p>{{welcome_message}}</p>\n{{/if}}';
    const legacyDe = '<h2>Hallo {{host_name}},</h2>\n{{#if welcome_message}}\n<p>{{welcome_message}}</p>\n{{/if}}';
    const id = await seedPost194({ enHtml: legacyEn, deHtml: legacyDe });

    await migration.up(knex);

    expect((await rowFor(id, 'en')).body_html).toBe(legacyEn);
    expect((await rowFor(id, 'de')).body_html).toBe(legacyDe);
  });

  it('is idempotent', async () => {
    const id = await seedPost194();

    await migration.up(knex);
    const once = await rowFor(id, 'en');
    const onceMaster = await knex('email_templates').where({ id }).first();
    await migration.up(knex);
    const twice = await rowFor(id, 'en');
    const twiceMaster = await knex('email_templates').where({ id }).first();

    expect(twice.body_html).toBe(once.body_html);
    expect(twiceMaster.variables).toBe(onceMaster.variables);
    expect(await knex('email_template_translations').where({ template_id: id }).count('* as c'))
      .toEqual([{ c: 3 }]);
  });

  it('no-ops when the template or the tables are absent', async () => {
    await expect(migration.up(knex)).resolves.toBeUndefined();
    await dropTables();
    await expect(migration.up(knex)).resolves.toBeUndefined();
    await createTables();
  });

  describe('the block actually renders', () => {
    it('shows the message when one is set and drops the block when it is not', async () => {
      const id = await seedPost194();
      await migration.up(knex);
      const html = (await rowFor(id, 'en')).body_html;

      const withMessage = safeTemplateReplace(html, { welcome_message: 'See you there!' }, { escapeHtml: true });
      expect(withMessage).toContain('<em>See you there!</em>');
      expect(withMessage).not.toContain('{{#if');
      expect(withMessage).not.toContain('{{/if}}');

      const without = safeTemplateReplace(html, { welcome_message: '' }, { escapeHtml: true });
      expect(without).not.toContain('welcome_message');
      expect(without).not.toContain('<em>');
    });
  });
});
