/**
 * The legacy pre-event reminder pass, end to end.
 *
 * eventReminderService -> SQLite with the full core-migration run
 * (helpers/crmDb). Pins: an event inside its reminder window is mailed at
 * its inline address with its event type's template and stamped
 * `event_reminder_sent_at`; a second pass doesn't mail it again; an event
 * outside the window is left for a later pass.
 */

const { bootCrmDb } = require('./helpers/crmDb');

jest.setTimeout(120000);

let db;
let cleanup;
let tmpDir;
let eventReminderService;

const prevCwd = process.cwd();

beforeAll(async () => {
  ({ db, cleanup, tmpDir } = await bootCrmDb());
  process.chdir(tmpDir);
  for (const [key, value, type] of [
    ['crm_event_reminders_enabled', true, 'boolean'],
    ['crm_event_reminders_days_before', 2, 'number'],
  ]) {
    await db('app_settings')
      .insert({ setting_key: key, setting_value: JSON.stringify(value), setting_type: type })
      .onConflict('setting_key').merge();
  }
  // Required after bootCrmDb: at module load it would initialise the db
  // module before the helper points it at the temp database.
  eventReminderService = require('../../src/services/eventReminderService');
}, 120000);

afterAll(async () => {
  process.chdir(prevCwd);
  if (cleanup) await cleanup();
});

const dayOffset = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

async function insertEvent(slug, eventDate, hostEmail) {
  const [row] = await db('events').insert({
    slug, event_type: 'other', event_name: `Event ${slug}`, event_date: eventDate,
    host_email: hostEmail, admin_email: 'admin@example.com', password_hash: 'x',
    share_link: `${slug}-share`, expires_at: new Date(Date.now() + 90 * 86400000).toISOString(),
  }).returning('id');
  return row.id ?? row;
}

describe('runEventReminderPass', () => {
  it('mails an event inside its window once and leaves a later one alone', async () => {
    const soon = await insertEvent('reminder-soon', dayOffset(1), 'soon@example.com');
    const later = await insertEvent('reminder-later', dayOffset(20), 'later@example.com');

    const first = await eventReminderService.runEventReminderPass();
    expect(first).toMatchObject({ sent: 1 });

    const queued = await db('email_queue').where({ recipient_email: 'soon@example.com' });
    expect(queued).toHaveLength(1);
    // The seeded per-type template wins over the group's catch-all.
    expect(queued[0].email_type).toBe('event_reminder_other');
    expect(Number(queued[0].event_id)).toBe(soon);
    expect((await db('events').where({ id: soon }).first()).event_reminder_sent_at).toBeTruthy();

    expect(await db('email_queue').where({ recipient_email: 'later@example.com' })).toHaveLength(0);
    expect((await db('events').where({ id: later }).first()).event_reminder_sent_at).toBeNull();

    const second = await eventReminderService.runEventReminderPass();
    expect(second.sent).toBe(0);
    expect(await db('email_queue').where({ recipient_email: 'soon@example.com' })).toHaveLength(1);
  });
});
