/**
 * Renaming an event type's slug_prefix must CASCADE to everything keyed on the
 * old slug, so a rename behaves like a rename rather than silently detaching
 * existing events/quotes and orphaning the per-type pre-event reminder template.
 */
const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

// bootCrmDb runs the full core-migration set in beforeAll.
jest.setTimeout(120000);

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

  it('carries brief templates and customer briefs over to the new slug', async () => {
    const [typeId] = await db('event_types').insert({ name: 'Ball', slug_prefix: 'ball', is_active: true });
    await db('project_brief_fields').insert({ occasion: 'ball', label: 'Dress code', field_type: 'short_text', position: 0 });
    await db('project_briefs').insert({ customer_account_id: customerId, occasion: 'ball' });

    await eventTypeService.updateEventType(typeId, { slug_prefix: 'dance' });

    expect(await db('project_brief_fields').where({ occasion: 'ball' }).first()).toBeUndefined();
    expect((await db('project_brief_fields').where({ occasion: 'dance' }).first()).label).toBe('Dress code');
    expect((await db('project_briefs').where({ customer_account_id: customerId }).first()).occasion).toBe('dance');
  });

  it('keeps a project brief on its occasion through a rename', async () => {
    const [typeId] = await db('event_types').insert({ name: 'Prom', slug_prefix: 'prom', is_active: true });
    const [fieldId] = await db('project_brief_fields').insert({ occasion: 'prom', label: 'Theme', field_type: 'short_text', position: 0 });
    const [projectId] = await db('projects').insert({ name: 'Prom night', status: 'active', event_type: 'prom' });
    const [briefId] = await db('project_briefs').insert({ project_id: projectId });
    await db('project_brief_values').insert({ brief_id: briefId, field_id: fieldId, label: 'Theme', field_type: 'short_text', value: JSON.stringify('Disco') });

    await eventTypeService.updateEventType(typeId, { slug_prefix: 'formal' });

    expect((await db('projects').where({ id: projectId }).first()).event_type).toBe('formal');
    const brief = await require('../../src/services/briefService').getBrief({ kind: 'project', id: projectId });
    expect(brief.fields.find((f) => f.id === fieldId)).toMatchObject({ source: 'occasion', value: 'Disco' });
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
