/**
 * Adding pt email content must not change what any other recipient gets, and
 * must not bring back a pt version an admin deleted (issue 2617).
 *
 * Rendering goes through the real processTemplate, before and after
 * migration 378, so its own fallbacks (requested language → en → any row →
 * legacy columns, field by field) decide what "unchanged" means.
 */

const { bootCrmDb } = require('./helpers/crmDb');

describe('pt email templates — repair paths', () => {
  let db; let cleanup; let processTemplate; let migration;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    ({ processTemplate } = require('../../src/services/emailProcessor'));
    migration = require('../../migrations/core/378_pt_email_template_translations');
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  const vars = { transfer_title: 'Hochzeit Müller', download_url: 'https://example.test/t/abc', expires_at: '2026-12-01' };

  async function legacyOnly(templateKey, legacy) {
    const template = await db('email_templates').where({ template_key: templateKey }).first();
    await db('email_template_translations').where({ template_id: template.id }).del();
    await db('email_templates').where({ id: template.id }).update(legacy);
    return db('email_templates').where({ id: template.id }).first();
  }

  async function render(templateKey, language) {
    const template = await db('email_templates').where({ template_key: templateKey }).first();
    const { subject, htmlBody, textBody } = await processTemplate(template, vars, language);
    return { subject, htmlBody, textBody };
  }

  it('keeps English and German mails when an empty pt row already existed', async () => {
    const template = await legacyOnly('transfer_ready', {
      subject_en: '{{transfer_title}} — your files are ready', body_html_en: '<p>Download: {{download_url}}</p>', body_text_en: 'Download: {{download_url}}',
      subject_de: '{{transfer_title}} — Ihre Dateien', body_html_de: '<p>Herunterladen: {{download_url}}</p>', body_text_de: 'Herunterladen: {{download_url}}',
    });
    const now = new Date().toISOString();
    await db('email_template_translations').insert({ template_id: template.id, language: 'pt', subject: '', body_html: '', body_text: '', created_at: now, updated_at: now });

    const before = { en: await render('transfer_ready', 'en'), de: await render('transfer_ready', 'de'), fr: await render('transfer_ready', 'fr') };
    await migration.up(db);
    expect(await render('transfer_ready', 'en')).toEqual(before.en);
    expect(await render('transfer_ready', 'de')).toEqual(before.de);
    expect(await render('transfer_ready', 'fr')).toEqual(before.fr);
    expect(before.de.subject).toContain('Ihre Dateien');
    expect((await render('transfer_ready', 'pt')).subject).toContain('Hochzeit Müller');
    expect((await render('transfer_ready', 'pt')).subject).not.toBe(before.en.subject);
  });

  it('keeps the English body of a German legacy template that only has a German subject', async () => {
    await legacyOnly('transfer_request', {
      subject_en: 'Please upload — {{transfer_title}}', body_html_en: '<p>Upload here: {{download_url}}</p>', body_text_en: 'Upload here: {{download_url}}',
      subject_de: 'Bitte hochladen — {{transfer_title}}', body_html_de: '', body_text_de: '',
    });
    const before = { en: await render('transfer_request', 'en'), de: await render('transfer_request', 'de') };
    await migration.up(db);
    const after = { en: await render('transfer_request', 'en'), de: await render('transfer_request', 'de') };
    expect(after).toEqual(before);
    expect(after.de.subject).toContain('Bitte hochladen');
    expect(after.de.htmlBody).toContain('https://example.test/t/abc');
  });

  // Each call loads the module fresh: it seeds once per process otherwise.
  const freshReminderSeeder = () => {
    let seed;
    jest.isolateModules(() => { ({ ensureEventReminderTemplatesSeeded: seed } = require('../../src/services/eventReminderTemplates')); });
    return seed;
  };

  it('does not re-create a pt reminder an admin deleted when the English repair runs', async () => {
    await freshReminderSeeder()(db, null);
    const template = await db('email_templates').where({ template_key: 'event_reminder_default' }).first();
    await db('email_template_translations').where({ template_id: template.id, language: 'pt' }).del();
    await db('email_template_translations').where({ template_id: template.id, language: 'en' })
      .update({ subject: '', body_html: '', body_text: '' });

    await freshReminderSeeder()(db, null);

    const en = await db('email_template_translations').where({ template_id: template.id, language: 'en' }).first();
    expect(en.subject).not.toBe('');
    expect(await db('email_template_translations').where({ template_id: template.id, language: 'pt' }).first()).toBeUndefined();
  });
});
