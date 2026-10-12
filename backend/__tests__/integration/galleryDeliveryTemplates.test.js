/**
 * The "complete gallery" mail (issue 1562) for a gallery without an expiry
 * date: no "available until null" line, and an install that stored the first
 * default is brought up to date while an edited template is left alone.
 */

describe('gallery_completed template', () => {
  let db; let cleanup;

  beforeAll(async () => {
    ({ db, cleanup } = await require('./helpers/crmDb').bootCrmDb());
  }, 180000);

  afterAll(async () => {
    if (cleanup) await cleanup();
  });

  // _seeded is module state: a fresh copy runs the seeder again.
  const seed = () => new Promise((resolve, reject) => {
    jest.isolateModules(() => {
      require('../../src/services/galleryDeliveryTemplates').ensureGalleryDeliveryTemplatesSeeded(db, null)
        .then(resolve, reject);
    });
  });

  it('leaves out the expiry line when the gallery has no expiry date', () => {
    const { safeTemplateReplace } = require('../../src/services/emailProcessor');
    const { GALLERY_DELIVERY_TEMPLATES } = require('../../src/services/galleryDeliveryTemplates');
    for (const language of ['en', 'de']) {
      const { body_html: html, body_text: text } = GALLERY_DELIVERY_TEMPLATES.gallery_completed[language];
      for (const body of [html, text]) {
        const rendered = safeTemplateReplace(body, { expiry_date: null, gallery_link: 'x' });
        expect(rendered).not.toMatch(/null|expiry_date|\{\{#if|\{\{\/if/);
        expect(safeTemplateReplace(body, { expiry_date: '31.12.2026', gallery_link: 'x' })).toContain('31.12.2026');
      }
    }
  });

  it('brings the unedited first default up to date and leaves an edited one alone', async () => {
    await seed();
    const row = await db('email_templates').where({ template_key: 'gallery_completed' }).first();
    expect(row).toBeTruthy();
    if (!(await db.schema.hasTable('email_template_translations'))) return;

    const { PREVIOUS_DEFAULTS } = require('../../src/services/galleryDeliveryTemplates');
    const old = PREVIOUS_DEFAULTS.gallery_completed;
    await db('email_template_translations').where({ template_id: row.id, language: 'en' })
      .update({ subject: old.en.subject, body_html: old.en.body_html, body_text: old.en.body_text });
    await db('email_template_translations').where({ template_id: row.id, language: 'de' })
      .update({ subject: old.de.subject, body_html: `${old.de.body_html}<p>Eigener Text</p>`, body_text: old.de.body_text });

    await seed();
    const en = await db('email_template_translations').where({ template_id: row.id, language: 'en' }).first();
    const de = await db('email_template_translations').where({ template_id: row.id, language: 'de' }).first();
    expect(en.body_html).toContain('{{#if expiry_date}}');
    expect(en.body_text).toContain('{{#if expiry_date}}');
    expect(de.body_html).toContain('Eigener Text');
    expect(de.body_html).not.toContain('{{#if expiry_date}}');
  });
});
