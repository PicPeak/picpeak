const { bootCrmDb } = require('./helpers/crmDb');

describe('paused photo purchase confirmation', () => {
  let db; let cleanup;
  beforeAll(async () => { ({ db, cleanup } = await bootCrmDb()); });
  afterAll(async () => { if (cleanup) await cleanup(); });

  it.each(['en', 'de'])('renders the successful purchase, same link, deadline and support address in %s', async (__language) => {
    const { renderQueuedEmail } = require('../../src/services/emailProcessor');
    const rendered = await renderQueuedEmail('photo_purchase_paused', {
      __language, gallery_name: 'Wedding', photo_count: 3,
      access_link: 'https://photos.example.test/purchased-downloads/proof',
      expires_at: '2026-12-01T12:00:00Z', support_email: 'help@example.test',
    }, 'buyer@example.test');
    expect(rendered).not.toBeNull();
    expect(rendered.subject).toContain(__language === 'en' ? 'Purchase confirmed' : 'Kauf bestätigt');
    expect(rendered.html).toContain('help@example.test');
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
});
