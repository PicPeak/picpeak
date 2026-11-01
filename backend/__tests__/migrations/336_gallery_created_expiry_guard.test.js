/**
 * A gallery without an expiry date got "Your gallery will be available until
 * null" in its gallery_created mail: no seeded copy guarded the line. The
 * migration puts the element holding {{expiry_date}} behind
 * {{#if expiry_date}} — in every locale and in the legacy columns — so the
 * mail drops it when there is no date and renders unchanged when there is.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const migration = require('../../migrations/core/336_gallery_created_expiry_guard');
const { safeTemplateReplace } = require('../../src/services/emailProcessor');

// Legacy 028 (English), the parts around the date, verbatim.
const EN_HTML = `<div style="background-color: #f9f9f9; padding: 20px; border-radius: 8px; margin: 20px 0;">
  <h3 style="margin-top: 0;">Your access data:</h3>
  <ul style="list-style: none; padding: 0;">
    <li style="margin-bottom: 10px;"><strong>Password:</strong> {{gallery_password}}</li>
  </ul>
</div>

<div style="background-color: #fff3cd; border: 1px solid #ffeaa7; color: #856404; padding: 15px; border-radius: 4px; margin: 20px 0;">
  <p style="margin: 0;"><strong>Important:</strong> Your gallery will be available until <strong>{{expiry_date}}</strong>. After this date, the photos will be archived and will only be available upon request.</p>
</div>

<p>We hope you enjoy your photos!</p>`;
const EN_TEXT = `Your access data:
- Password: {{gallery_password}}

Important: Your gallery will be available until {{expiry_date}}. After this date, the photos will be archived and will only be available upon request.

We hope you enjoy your photos!`;

// Legacy 026 (German): a list item and a multi-line warning paragraph.
const DE_HTML = `{{#if welcome_message}}
<div style="background-color: #f3f4f6;">
  <p style="margin: 0;">{{welcome_message}}</p>
</div>
{{/if}}
<ul>
  <li>Passwort: {{gallery_password}}</li>
  <li>Ablaufdatum: {{expiry_date}}</li>
</ul>
<p style="background-color: #FEF3C7; padding: 15px; border-radius: 5px; border-left: 4px solid #F59E0B;">
  <strong>Wichtig:</strong> Diese Galerie läuft am {{expiry_date}} ab. Nach diesem Datum werden die Fotos archiviert und sind nicht mehr zugänglich.
</p>
<p>Mit freundlichen Grüßen</p>`;
const DE_TEXT = `- Passwort: {{gallery_password}}
- Ablaufdatum: {{expiry_date}}

WICHTIG: Diese Galerie läuft am {{expiry_date}} ab.

Mit freundlichen Grüßen`;

// 075 (Dutch): the one-line list item every later locale seed uses.
const NL_HTML = `<ul>
  <li>Wachtwoord: {{gallery_password}}</li>
  <li>Verloopt op: {{expiry_date}}</li>
</ul>
{{#if welcome_message}}<p><em>{{welcome_message}}</em></p>{{/if}}`;

const WITH_DATE = { gallery_password: 'pw', expiry_date: '24 October 2026', welcome_message: '' };
const NO_DATE = { ...WITH_DATE, expiry_date: null };

describe('migration 336 — {{#if expiry_date}} around the gallery_created expiry line', () => {
  let knex; let tmpDir;

  beforeAll(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'picpeak-mig336-'));
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
    await knex.schema.dropTableIfExists('email_template_translations');
    await knex.schema.dropTableIfExists('email_templates');
    await knex.schema.createTable('email_templates', (t) => {
      t.increments('id').primary();
      t.string('template_key').unique().notNullable();
      t.text('body_html_en');
      t.text('body_text_en');
      t.text('body_html_de');
      t.string('updated_at');
    });
    await knex.schema.createTable('email_template_translations', (t) => {
      t.increments('id').primary();
      t.integer('template_id');
      t.string('language', 10);
      t.text('body_html');
      t.text('body_text');
      t.string('updated_at');
    });
  });

  const seed = async (key = 'gallery_created') => {
    const [id] = await knex('email_templates').insert({
      template_key: key, body_html_en: EN_HTML, body_text_en: EN_TEXT, body_html_de: DE_HTML,
    });
    await knex('email_template_translations').insert([
      { template_id: id, language: 'en', body_html: EN_HTML, body_text: EN_TEXT },
      { template_id: id, language: 'de', body_html: DE_HTML, body_text: DE_TEXT },
      { template_id: id, language: 'nl', body_html: NL_HTML, body_text: null },
    ]);
    return id;
  };
  const translation = (language) => knex('email_template_translations').where({ language }).first();
  const render = (body, vars) => safeTemplateReplace(body, vars);

  it('drops every expiry element when the gallery has no date', async () => {
    await seed();
    await migration.up(knex);

    for (const language of ['en', 'de', 'nl']) {
      const row = await translation(language);
      const html = render(row.body_html, NO_DATE);
      expect(html).not.toMatch(/null|\{\{|available until|Ablaufdatum|Wichtig|Verloopt/);
      expect(html).toContain('pw');
    }
    const en = await translation('en');
    expect(render(en.body_text, NO_DATE)).toBe(`Your access data:
- Password: pw

We hope you enjoy your photos!`);
    const de = await translation('de');
    expect(render(de.body_text, NO_DATE)).toBe(`- Passwort: pw

Mit freundlichen Grüßen`);
    // The whole warning box goes, not just the paragraph inside it.
    expect(render(en.body_html, NO_DATE)).not.toContain('#fff3cd');
  });

  it('renders exactly as before when the gallery has a date', async () => {
    await seed();
    await migration.up(knex);
    const before = { en: [EN_HTML, EN_TEXT], de: [DE_HTML, DE_TEXT], nl: [NL_HTML, null] };
    for (const [language, [html, text]] of Object.entries(before)) {
      const row = await translation(language);
      expect(render(row.body_html, WITH_DATE)).toBe(render(html, WITH_DATE));
      if (text) expect(render(row.body_text, WITH_DATE)).toBe(render(text, WITH_DATE));
    }
  });

  it('guards the legacy fallback columns too', async () => {
    await seed();
    await migration.up(knex);
    const master = await knex('email_templates').first();
    expect(render(master.body_html_en, NO_DATE)).not.toContain('available until');
    expect(render(master.body_text_en, NO_DATE)).not.toContain('available until');
    expect(render(master.body_html_de, NO_DATE)).not.toContain('Ablaufdatum');
  });

  it('is idempotent and leaves a body that already guards the date alone', async () => {
    await seed();
    await migration.up(knex);
    const once = await knex('email_template_translations').orderBy('id');
    await migration.up(knex);
    expect(await knex('email_template_translations').orderBy('id')).toEqual(once);
  });

  it('does not nest a guard inside another {{#if}} block', async () => {
    const [id] = await knex('email_templates').insert({ template_key: 'gallery_created' });
    const body = '{{#if welcome_message}}<p>Until {{expiry_date}}</p>{{/if}}';
    await knex('email_template_translations').insert({ template_id: id, language: 'en', body_html: body });
    await migration.up(knex);
    expect((await translation('en')).body_html).toBe(body);
  });

  it('does not wrap an element that holds a {{#if}} block of its own', async () => {
    const [id] = await knex('email_templates').insert({ template_key: 'gallery_created' });
    const html = '<p>{{#if welcome_message}}Hi. {{/if}}Until {{expiry_date}}</p>';
    const text = 'Hello\n{{#if welcome_message}}Hi. {{/if}}Until {{expiry_date}}';
    await knex('email_template_translations').insert({ template_id: id, language: 'en', body_html: html, body_text: text });
    await migration.up(knex);
    const row = await translation('en');
    expect(row.body_html).toBe(html);
    expect(row.body_text).toBe(text);
  });

  it('does not hide another value that shares the element with the date', async () => {
    const [id] = await knex('email_templates').insert({ template_key: 'gallery_created' });
    const html = '<p>Password {{gallery_password}}, available until {{expiry_date}}</p>';
    await knex('email_template_translations').insert({ template_id: id, language: 'en', body_html: html, body_text: html });
    await migration.up(knex);
    const row = await translation('en');
    expect(row.body_html).toBe(html);
    expect(row.body_text).toBe(html);
  });

  it('guards the line a partly guarded body still prints', async () => {
    const [id] = await knex('email_templates').insert({ template_key: 'gallery_created' });
    const html = '{{#if expiry_date}}<li>Until {{expiry_date}}</li>{{/if}}\n<p>Expires {{expiry_date}}.</p>';
    await knex('email_template_translations').insert({ template_id: id, language: 'en', body_html: html });
    await migration.up(knex);
    expect(render((await translation('en')).body_html, NO_DATE)).toBe('\n');
  });

  it('touches no other template', async () => {
    await seed('gallery_expired');
    await migration.up(knex);
    expect((await translation('en')).body_html).toBe(EN_HTML);
  });
});
