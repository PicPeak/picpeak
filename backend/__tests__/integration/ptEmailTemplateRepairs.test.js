/**
 * Adding pt email content must not change what any other recipient gets, and
 * must not bring back a pt version an admin deleted (issue 2617).
 *
 * Rendering goes through the real processTemplate, before and after
 * migration 378, so its own fallbacks (requested language → en → any row →
 * legacy columns, field by field) decide what "unchanged" means.
 */

const { bootCrmDb } = require('./helpers/crmDb');
const { definePtTemplateRepairScenarios } = require('./helpers/ptTemplateRepairScenarios');

describe('pt email templates — repair paths', () => {
  let db; let cleanup; let processTemplate; let migration;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    ({ processTemplate } = require('../../src/services/emailProcessor'));
    migration = require('../../migrations/core/378_pt_email_template_translations');
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  definePtTemplateRepairScenarios(() => ({ db, processTemplate, migration }));

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
