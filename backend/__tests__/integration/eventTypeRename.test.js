/**
 * Renaming an event type's slug_prefix must CASCADE to everything keyed on the
 * old slug, so a rename behaves like a rename rather than silently detaching
 * existing events/quotes and orphaning the per-type pre-event reminder template.
 */
const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

// bootCrmDb runs the full core-migration set in beforeAll.
jest.setTimeout(30000);

describe('event type slug rename cascade', () => {
  let db;
  let cleanup;
  let customerId;
  let eventTypeService;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    ({ customerId } = await seedMinimal(db));
    eventTypeService = require('../../src/services/eventTypeService');
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  it('re-points events + quotes + the reminder template from old slug to new', async () => {
    // A non-system event type with slug 'party'.
    const [typeId] = await db('event_types').insert({ name: 'Party', slug_prefix: 'party', is_active: true });

    // An authored per-type reminder template + an event + a quote, all on 'party'.
    await db('email_templates').insert({ template_key: 'event_reminder_party', subject_en: 'Party reminder' });
    await db('events').insert({
      event_type: 'party', password_hash: 'x', expires_at: new Date(Date.now() + 9e9).toISOString(),
      is_active: true, is_archived: false, slug: 'party-ev', share_link: 'party-ev',
      event_name: 'A party', event_date: '2026-09-01',
    });
    await db('quotes').insert({
      quote_number: 'Q-PARTY-1', customer_account_id: customerId, issue_date: '2026-01-01', event_type: 'party',
    });

    // Rename the slug.
    await eventTypeService.updateEventType(typeId, { slug_prefix: 'concert' });

    // Event + quote follow the rename.
    expect((await db('events').where({ slug: 'party-ev' }).first()).event_type).toBe('concert');
    expect((await db('quotes').where({ quote_number: 'Q-PARTY-1' }).first()).event_type).toBe('concert');
    // The authored reminder template moved (subject/body preserved), old key gone.
    expect(await db('email_templates').where({ template_key: 'event_reminder_party' }).first()).toBeUndefined();
    const moved = await db('email_templates').where({ template_key: 'event_reminder_concert' }).first();
    expect(moved).toBeTruthy();
    expect(moved.subject_en).toBe('Party reminder');
  });

  it('does not clobber an existing template for the new slug', async () => {
    const [typeId] = await db('event_types').insert({ name: 'Gala', slug_prefix: 'gala', is_active: true });
    await db('email_templates').insert({ template_key: 'event_reminder_gala', subject_en: 'old gala' });
    await db('email_templates').insert({ template_key: 'event_reminder_soiree', subject_en: 'existing soiree' });

    await eventTypeService.updateEventType(typeId, { slug_prefix: 'soiree' });

    // Target already existed → left intact; source not force-merged over it.
    expect((await db('email_templates').where({ template_key: 'event_reminder_soiree' }).first()).subject_en)
      .toBe('existing soiree');
  });
});
