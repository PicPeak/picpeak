/**
 * Setup-window event type deletion (#800).
 *
 * The first-run setup wizard may delete the seeded SYSTEM event types —
 * but ONLY while the `setup_wizard_completed` flag is unset (migration 161
 * seeds it false on a fresh install, true when an admin already exists).
 * These tests pin the whole contract:
 *
 *   - fresh install → flag false → system types deletable (in-use checks
 *     still apply), and the per-type reminder template goes with the type
 *   - reminder-template self-heal does NOT resurrect templates for slugs
 *     that no longer exist in the catalog
 *   - after markSetupWizardCompleted() → system deletion is refused again
 */

const { bootCrmDb } = require('./helpers/crmDb');
const { decodeSettingValue } = require('../helpers/settingValue');

describe('event type deletion during the setup window (#800)', () => {
  let db;
  let cleanup;
  let eventTypeService;
  let setupService;
  let ensureEventReminderTemplatesSeeded;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    // Require AFTER bootCrmDb so every service shares this db instance
    // (see crmDb.js — a second knex pool on one SQLite file deadlocks).
    eventTypeService = require('../../src/services/eventTypeService');
    setupService = require('../../src/services/setupService');
    ({ ensureEventReminderTemplatesSeeded } = require('../../src/services/eventReminderTemplates'));
  }, 120000);

  afterAll(async () => {
    if (cleanup) await cleanup();
  });

  it('migration 161 seeds the flag false on a fresh (admin-less) install', async () => {
    const row = await db('app_settings').where({ setting_key: 'setup_wizard_completed' }).first();
    expect(row).toBeTruthy();
    expect(decodeSettingValue(db, row.setting_value)).toBe(false);
    expect(await setupService.isSetupWizardCompleted()).toBe(false);
  });

  it('refuses to delete a system type that events already use, even in the window', async () => {
    const corporate = await db('event_types').where({ slug_prefix: 'corporate' }).first();
    await db('events').insert({
      slug: 'corporate-test-2026-01-01',
      event_name: 'Test',
      event_type: 'corporate',
      event_date: '2026-01-01',
      host_email: 'host@example.com',
      admin_email: 'admin@example.com',
      password_hash: 'x',
      share_link: 'share-corporate-test',
      expires_at: new Date(Date.now() + 86400000),
    });

    await expect(eventTypeService.deleteEventType(corporate.id))
      .rejects.toMatchObject({ code: 'IN_USE' });
  });

  it('deletes an unused system type in the window, taking its reminder template along', async () => {
    // Seed the per-type reminder templates first so there is something to clean up.
    await ensureEventReminderTemplatesSeeded(db);
    expect(await db('email_templates').where({ template_key: 'event_reminder_wedding' }).first()).toBeTruthy();

    const wedding = await db('event_types').where({ slug_prefix: 'wedding' }).first();
    expect(wedding.is_system).toBeTruthy();

    const result = await eventTypeService.deleteEventType(wedding.id);
    expect(result.success).toBe(true);

    expect(await db('event_types').where({ slug_prefix: 'wedding' }).first()).toBeFalsy();
    expect(await db('email_templates').where({ template_key: 'event_reminder_wedding' }).first()).toBeFalsy();

    // The deleted slug must NOT stay creatable through the legacy fallback —
    // the live catalog is authoritative while it has rows.
    expect(await eventTypeService.isValidEventType('wedding')).toBe(false);
    expect(await eventTypeService.isValidEventType('birthday')).toBe(true);
  });

  it('does not resurrect reminder templates for deleted types on the next self-heal pass', async () => {
    // The seeder caches success per process — reset the module to force a
    // genuine second pass, exactly what a backend restart would run.
    jest.resetModules();
    const fresh = require('../../src/services/eventReminderTemplates');
    await fresh.ensureEventReminderTemplatesSeeded(db);

    expect(await db('email_templates').where({ template_key: 'event_reminder_wedding' }).first()).toBeFalsy();
    // Types still in the catalog keep their templates.
    expect(await db('email_templates').where({ template_key: 'event_reminder_birthday' }).first()).toBeTruthy();
    expect(await db('email_templates').where({ template_key: 'event_reminder_default' }).first()).toBeTruthy();
  });

  it('re-locks system types once the wizard is marked complete', async () => {
    await setupService.markSetupWizardCompleted();
    expect(await setupService.isSetupWizardCompleted()).toBe(true);

    const birthday = await db('event_types').where({ slug_prefix: 'birthday' }).first();
    await expect(eventTypeService.deleteEventType(birthday.id))
      .rejects.toMatchObject({ code: 'SYSTEM_TYPE' });

    // Custom (non-system) types remain deletable as before.
    const custom = await eventTypeService.createEventType({ name: 'Family', slug_prefix: 'family' });
    const result = await eventTypeService.deleteEventType(custom.id);
    expect(result.success).toBe(true);
  });

  it('fails closed when the completion marker row is missing', async () => {
    // A portable-backup restore can replace app_settings with a set that
    // predates migration 161 (which will not rerun) — absence must mean
    // "configured instance", never an open deletion window.
    await db('app_settings').where({ setting_key: 'setup_wizard_completed' }).del();
    expect(await setupService.isSetupWizardCompleted()).toBe(true);
    await setupService.markSetupWizardCompleted();
  });

  it('refuses to delete the last remaining event type', async () => {
    // Reduce the catalog to a single custom type via direct db writes (the
    // service paths are already covered above), then hit the guard.
    const solo = await eventTypeService.createEventType({ name: 'Solo', slug_prefix: 'solo' });
    await db('events').del();
    await db('event_types').whereNot('id', solo.id).del();

    await expect(eventTypeService.deleteEventType(solo.id))
      .rejects.toMatchObject({ code: 'LAST_TYPE' });

    // Deactivating it would empty the ACTIVE catalog just the same.
    await expect(eventTypeService.updateEventType(solo.id, { is_active: false }))
      .rejects.toMatchObject({ code: 'LAST_ACTIVE' });
  });
});
