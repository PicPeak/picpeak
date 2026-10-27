const { bootCrmDb } = require('./helpers/crmDb');

describe('paused photo purchase confirmation', () => {
  let db; let cleanup; let defaults;
  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    const template = await db('email_templates').where({ template_key: 'photo_purchase_paused' }).first();
    const translations = await db('email_template_translations').where({ template_id: template.id });
    defaults = { template, translations };
  });
  afterAll(async () => { if (cleanup) await cleanup(); });

  it.each(['en', 'de'])('renders the successful purchase, same link, pause compensation, gallery cutoff and support address in %s', async (__language) => {
    const { renderQueuedEmail } = require('../../src/services/emailProcessor');
    const rendered = await renderQueuedEmail('photo_purchase_paused', {
      __language, gallery_name: 'Wedding', photo_count: 3,
      access_link: 'https://photos.example.test/purchased-downloads/proof',
      expires_at: '2026-12-01T12:00:00Z', expiry_date: '2026-12-31T12:00:00Z', support_email: 'help@example.test',
    }, 'buyer@example.test');
    expect(rendered).not.toBeNull();
    expect(rendered.subject).toContain(__language === 'en' ? 'Purchase confirmed' : 'Kauf bestätigt');
    expect(rendered.html).toContain('help@example.test');
    expect(rendered.html).toContain(__language === 'en' ? 'Time lost during the pause' : 'Pausenzeit');
    expect(rendered.html).toContain(__language === 'en' ? 'final cutoff' : 'endgültige Grenze');
    expect(rendered.html).toContain('https://photos.example.test/purchased-downloads/proof');
    expect(rendered.html).not.toMatch(/\{\{(?:access_link|expires_at|support_email|photo_count)\}\}/);
  });

  it('does not overwrite a customised confirmation on migration rerun', async () => {
    const migration = require('../../migrations/core/329_photo_purchase_paused_email_template');
    const row = await db('email_templates').where({ template_key: 'photo_purchase_paused' }).first();
    await db('email_template_translations').where({ template_id: row.id, language: 'en' }).update({ subject: 'Studio confirmation' });
    await migration.up(db);
    const updated = await db('email_template_translations').where({ template_id: row.id, language: 'en' }).first();
    expect(updated.subject).toBe('Studio confirmation');
    expect(await db('email_templates').where({ template_key: 'photo_purchase_paused' })).toHaveLength(1);
  });

  describe('forward upgrade of the original development defaults', () => {
    const migration = require('../../migrations/core/333_refresh_paused_purchase_email_defaults');
    // Recreate the original 329 content independently from the forward
    // migration, including its informal German and fixed-deadline promise.
    function legacy(content, language) {
      return Object.fromEntries(['subject', 'body_html', 'body_text'].map((field) => {
        let value = content[field];
        if (language === 'en') value = value
          .replace('Time lost during the pause will be added to your download window when the gallery returns.',
            'Your access deadline has not changed: {{expires_at}}.')
          .replace('\n{{#if expiry_date}}<p>The gallery expiry remains the final cutoff: {{expiry_date}}.</p>{{/if}}', '')
          .replace('\n\n{{#if expiry_date}}The gallery expiry remains the final cutoff: {{expiry_date}}.{{/if}}', '');
        else value = value.replaceAll('Ihr Kauf', 'Dein Kauf')
          .replace('Bitte verwenden Sie denselben Link', 'Bitte verwende denselben Link')
          .replace('Die Pausenzeit wird Ihrer Zugriffsfrist gutgeschrieben, sobald die Galerie wieder verfügbar ist.',
            'Deine Zugriffsfrist bleibt unverändert: {{expires_at}}.')
          .replace('\n{{#if expiry_date}}<p>Der Ablauf der Galerie bleibt die endgültige Grenze: {{expiry_date}}.</p>{{/if}}', '')
          .replace('\n\n{{#if expiry_date}}Der Ablauf der Galerie bleibt die endgültige Grenze: {{expiry_date}}.{{/if}}', '')
          .replace('Weitere Informationen erhalten Sie unter', 'Weitere Informationen erhältst du unter');
        return [field, value];
      }));
    }
    let previous;
    beforeEach(async () => {
      previous = Object.fromEntries(defaults.translations.map((row) => [row.language, legacy(row, row.language)]));
      const master = {};
      for (const field of Object.keys(defaults.template)) {
        const type = /^subject(?:_[a-z]{2,3})?$/.test(field) ? 'subject'
          : /^body_html(?:_[a-z]{2,3})?$/.test(field) ? 'body_html'
            : /^body_text(?:_[a-z]{2,3})?$/.test(field) ? 'body_text' : null;
        if (type) master[field] = previous.en[type];
      }
      master.variables = JSON.stringify(['gallery_name', 'access_link', 'photo_count', 'purchased_at', 'expires_at', 'support_email']);
      await db('email_templates').where({ id: defaults.template.id }).update(master);
      for (const language of ['en', 'de']) {
        await db('email_template_translations').where({ template_id: defaults.template.id, language }).update(previous[language]);
      }
    });

    it('updates untouched EN/DE messages and legacy fallbacks once without duplicating templates', async () => {
      await migration.up(db);
      const read = () => db('email_template_translations').where({ template_id: defaults.template.id }).orderBy('language');
      const first = await read();
      for (const row of defaults.translations) {
        expect(first.find((item) => item.language === row.language)).toMatchObject({
          subject: row.subject, body_html: row.body_html, body_text: row.body_text,
        });
      }
      const updated = await db('email_templates').where({ id: defaults.template.id }).first();
      expect(updated.body_html_en).toBe(defaults.template.body_html_en);
      expect(updated.body_html_en).toContain('Time lost during the pause');
      expect(typeof updated.variables === 'string' ? JSON.parse(updated.variables) : updated.variables).toContain('expiry_date');
      await migration.up(db);
      await migration.down(db);
      expect(await read()).toEqual(first);
      expect(await db('email_templates').where({ template_key: 'photo_purchase_paused' })).toHaveLength(1);
    });

    it.each(['subject', 'body_html', 'body_text'])('preserves a translation customised only in %s and upgrades the other language', async (field) => {
      const custom = { ...previous.en, [field]: `Studio ${field}` };
      await db('email_template_translations').where({ template_id: defaults.template.id, language: 'en' }).update(custom);
      await migration.up(db);
      expect(await db('email_template_translations').where({ template_id: defaults.template.id, language: 'en' }).first())
        .toMatchObject(custom);
      expect(await db('email_template_translations').where({ template_id: defaults.template.id, language: 'de' }).first())
        .toMatchObject({ body_html: defaults.translations.find((row) => row.language === 'de').body_html });
    });

    it('preserves customised legacy fallback content and variable definitions', async () => {
      const variables = JSON.stringify(['gallery_name', 'studio_message']);
      await db('email_templates').where({ id: defaults.template.id }).update({ subject_en: 'Studio confirmation', variables });
      await migration.up(db);
      const row = await db('email_templates').where({ id: defaults.template.id }).first();
      expect(row).toMatchObject({ subject_en: 'Studio confirmation', body_html_en: previous.en.body_html });
      expect(typeof row.variables === 'string' ? JSON.parse(row.variables) : row.variables).toEqual(JSON.parse(variables));
    });
  });
});
