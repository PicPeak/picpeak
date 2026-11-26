/**
 * Project briefs (issue 2678, migration 376) through the real routes on
 * SQLite: templates, project and customer briefs, the notify diff and mail,
 * and the portal's read, which must never carry a hidden field, an internal
 * note or another customer's brief.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID: uuid } = require('crypto');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'project-briefs-')), 'db.sqlite');
process.env.JWT_SECRET = 'project-briefs-tests-long-secret-not-production';
process.env.DATABASE_CLIENT = 'sqlite3';

const request = require('supertest');
const jwt = require('jsonwebtoken');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp, setFeatureFlags,
} = require('./helpers/crmDb');
const migration = require('../../migrations/core/376_project_briefs');

jest.setTimeout(120000);

const idOf = (rows) => rows[0].id ?? rows[0];

let db; let cleanup; let adminApp; let customerApp;
let superAdmin; let otherAdmin; let viewer;

const admin = (method, url, id = superAdmin) => request(adminApp)[method](`/api/admin/briefs${url}`)
  .set('Authorization', `Bearer ${mintAdminToken(id)}`);
const portal = (customerId) => request(customerApp).get('/api/customer/agreements')
  .set('Cookie', `customer_token=${jwt.sign({ type: 'customer', customerId, jti: uuid() }, process.env.JWT_SECRET, { issuer: 'picpeak-auth' })}`);

async function role(name, permissions) {
  const roleId = idOf(await db('roles').insert({ name, display_name: name }).returning('id'));
  for (const p of await db('permissions').whereIn('name', permissions)) {
    await db('role_permissions').insert({ role_id: roleId, permission_id: p.id });
  }
  return roleId;
}
async function adminWith(roleId) {
  return idOf(await db('admin_users').insert({
    username: uuid().slice(0, 12), email: `${uuid()}@example.test`, password_hash: 'x',
    must_change_password: false, created_at: new Date().toISOString(), role_id: roleId,
  }).returning('id'));
}
async function customer(extra = {}) {
  return idOf(await db('customer_accounts').insert({
    email: `${uuid()}@example.test`, display_name: 'Anna', is_active: true, password_hash: 'x',
    preferred_language: 'en', notes: 'INTERNAL-CUSTOMER-NOTE', created_at: new Date().toISOString(), ...extra,
  }).returning('id'));
}
async function project(customerId, extra = {}) {
  return idOf(await db('projects').insert({
    name: 'Anna & Ben', status: 'active', customer_account_id: customerId, created_by: superAdmin,
    event_type: 'wedding', event_date: '2027-06-12', guest_count: 80, location: 'Castle Hill',
    notes: 'INTERNAL-PROJECT-NOTE', created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    ...extra,
  }).returning('id'));
}
const weddingFields = async () => (await admin('get', '/templates')).body.templates.occasions.wedding;
const fieldId = async (label) => (await weddingFields()).find((f) => f.label === label).id;
const mails = (to) => db('email_queue').where({ email_type: 'project_brief_updated', recipient_email: to });

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  ({ adminId: superAdmin } = await seedMinimal(db));
  await assignAdminRole(db, superAdmin, 'super_admin');
  otherAdmin = await adminWith((await db('roles').where({ name: 'admin' }).first()).id);
  viewer = await adminWith(await role('brief-viewer', ['events.view', 'customers.view', 'settings.view']));
  adminApp = buildRouteApp('/api/admin/briefs', require('../../src/routes/adminBriefs'));
  customerApp = buildRouteApp('/api/customer', require('../../src/routes/customer'));
}, 300000);

afterAll(async () => { if (cleanup) await cleanup(); });

describe('migration 376', () => {
  it('seeds the wedding template and the update mail in every shipped language, and re-runs cleanly', async () => {
    await migration.up(db);
    const fields = await db('project_brief_fields').where({ occasion: 'wedding' }).orderBy('position');
    expect(fields.map((f) => f.field_type)).toEqual([
      'short_text', 'short_text', 'project_date', 'place_time', 'place_time', 'place_time', 'place_time', 'place',
      'project_guests', 'date',
    ]);
    expect(JSON.parse(fields[0].label_translations).de).toBe('Name der Braut');
    const template = await db('email_templates').where({ template_key: 'project_brief_updated' }).first();
    const languages = await db('email_template_translations').where({ template_id: template.id }).pluck('language');
    expect(languages.sort()).toEqual(['de', 'en', 'es', 'fr', 'nl', 'pt', 'ru', 'sl']);
  });

  it('uses only the variables the sender passes, in every language', () => {
    const PLACEHOLDER = /\{\{\s*(?:#if\s+)?(\w+)\s*\}\}/g;
    for (const [language, content] of Object.entries(migration.TRANSLATIONS)) {
      const used = Object.values(content).flatMap((v) => [...v.matchAll(PLACEHOLDER)].map((m) => m[1]));
      for (const name of used) expect(`${language}:${name}`).toBe(`${language}:${migration.TEMPLATE_VARIABLES.includes(name) ? name : '(not sent)'}`);
    }
  });
});

describe('with the projects flag off', () => {
  it('refuses the admin and the portal routes', async () => {
    await setFeatureFlags(db, { projects: false });
    const c = await customer();
    expect((await admin('get', '/templates')).status).toBe(403);
    expect((await admin('get', `/customers/${c}`)).body.code).toBe('PROJECTS_DISABLED');
    const res = await portal(c);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('CUSTOMER_FEATURE_DISABLED');
  });
});

describe('with the projects flag on', () => {
  beforeAll(async () => { await setFeatureFlags(db, { projects: true }); });

  describe('templates', () => {
    it('replaces a list in the given order, keeps ids, translations and removes the rest', async () => {
      const res = await admin('put', '/templates/global').send({ fields: [
        { label: 'Contact on the day', type: 'short_text', labels: { de: 'Ansprechperson am Tag', xx: undefined } },
        { label: 'Internal remark', type: 'long_text', visibleDefault: false },
      ] });
      expect(res.status).toBe(200);
      expect(res.body.fields.map((f) => [f.label, f.type, f.visibleDefault])).toEqual([
        ['Contact on the day', 'short_text', true], ['Internal remark', 'long_text', false],
      ]);
      expect(res.body.fields[0].labels).toEqual({ de: 'Ansprechperson am Tag' });
      const [a, b] = res.body.fields;
      const again = await admin('put', '/templates/global').send({ fields: [{ ...b }, { ...a, label: 'Contact person' }] });
      expect(again.body.fields.map((f) => [f.id, f.label])).toEqual([[b.id, 'Internal remark'], [a.id, 'Contact person']]);
    });

    it('refuses a type change, an unknown type, an unknown occasion, too many fields and a foreign id', async () => {
      const [field] = (await admin('get', '/templates')).body.templates.global;
      expect((await admin('put', '/templates/global').send({ fields: [{ ...field, type: 'number' }] })).status).toBe(400);
      expect((await admin('put', '/templates/global').send({ fields: [{ label: 'X', type: 'script' }] })).status).toBe(400);
      expect((await admin('put', '/templates/nope').send({ fields: [] })).status).toBe(404);
      const many = Array.from({ length: 51 }, (_, i) => ({ label: `F${i}`, type: 'short_text' }));
      expect((await admin('put', '/templates/global').send({ fields: many })).status).toBe(400);
      const wedding = await weddingFields();
      expect((await admin('put', '/templates/global').send({ fields: [wedding[0]] })).status).toBe(400);
      expect((await admin('put', '/templates/global').send({ fields: [{ label: 'x'.repeat(121), type: 'short_text' }] })).status).toBe(400);
    });

    it('needs settings.edit to change a template', async () => {
      expect((await admin('get', '/templates', viewer)).status).toBe(200);
      expect((await admin('put', '/templates/global', viewer).send({ fields: [] })).status).toBe(403);
    });
  });

  describe('a project brief', () => {
    let customerId; let projectId;
    beforeAll(async () => {
      customerId = await customer();
      projectId = await project(customerId);
    });

    it('shows the global fields first, then the occasion, with the project data in the project fields', async () => {
      const res = await admin('get', `/projects/${projectId}`);
      expect(res.status).toBe(200);
      const { fields } = res.body.brief;
      expect(fields.slice(0, 2).map((f) => [f.label, f.source])).toEqual([['Internal remark', 'global'], ['Contact person', 'global']]);
      expect(fields[2]).toMatchObject({ label: 'Bride\'s name', source: 'occasion' });
      expect(fields.find((f) => f.type === 'project_date')).toMatchObject({ value: '2027-06-12', fromProject: true });
      expect(fields.find((f) => f.type === 'project_guests')).toMatchObject({ value: 80, fromProject: true });
      // The project data is customer-visible before the brief is ever saved.
      expect(res.body.brief).toMatchObject({ occasion: 'wedding', notifiedAt: null, hasCustomer: true });
      expect(res.body.brief.pendingChanges.map((c) => [c.label, c.change])).toEqual([['Wedding date', 'added'], ['Guest count', 'added']]);
    });

    it('stores typed values and refuses what does not fit the type', async () => {
      const bride = await fieldId('Bride\'s name');
      const pickup = await fieldId('Bride pickup');
      const plusOne = await fieldId('Plus-one allowed until');
      const res = await admin('put', `/projects/${projectId}`).send({
        values: {
          [bride]: { value: '  Anna  ' },
          [pickup]: { value: { place: 'Hotel Rose', address: 'Main St 1', time: '09:30' } },
          [plusOne]: { value: '2027-05-01' },
        },
        sharedArrangements: 'Coffee at 9.',
      });
      expect(res.status).toBe(200);
      const byId = new Map(res.body.brief.fields.map((f) => [f.id, f]));
      expect(byId.get(bride).value).toBe('Anna');
      expect(byId.get(pickup).value).toEqual({ place: 'Hotel Rose', address: 'Main St 1', time: '09:30' });
      expect(res.body.brief.sharedArrangements).toBe('Coffee at 9.');

      for (const [id, value] of [[pickup, { place: 'X', time: '25:00' }], [plusOne, '2027-02-30'], [bride, 'x'.repeat(501)], [bride, 42]]) {
        expect((await admin('put', `/projects/${projectId}`).send({ values: { [id]: { value } } })).status).toBe(400);
      }
      expect((await admin('put', `/projects/${projectId}`).send({ values: { 999999: { value: 'x' } } })).status).toBe(400);
    });

    it('leaves the project fields to the project data', async () => {
      const date = (await weddingFields()).find((f) => f.type === 'project_date').id;
      expect((await admin('put', `/projects/${projectId}`).send({ values: { [date]: { value: '2027-01-01' } } })).status).toBe(400);
      expect((await admin('put', `/projects/${projectId}`).send({ values: { [date]: { visible: false } } })).status).toBe(200);
      const field = (await admin('get', `/projects/${projectId}`)).body.brief.fields.find((f) => f.id === date);
      expect(field).toMatchObject({ visible: false, value: '2027-06-12' });
    });

    it('is the project owner\'s: another admin gets 404, a viewer cannot save', async () => {
      expect((await admin('get', `/projects/${projectId}`, otherAdmin)).status).toBe(404);
      expect((await admin('put', `/projects/${projectId}`, otherAdmin).send({ sharedArrangements: 'x' })).status).toBe(404);
      expect((await admin('post', `/projects/${projectId}/notify`, otherAdmin)).status).toBe(404);
      expect((await admin('put', `/projects/${projectId}`, viewer).send({ sharedArrangements: 'x' })).status).toBe(403);
    });

    it('counts only customer-visible changes and sends them in one mail', async () => {
      const remark = (await admin('get', '/templates')).body.templates.global.find((f) => f.label === 'Internal remark').id;
      await admin('put', `/projects/${projectId}`).send({ values: { [remark]: { value: 'HIDDEN-REMARK' } } });
      const { brief } = (await admin('get', `/projects/${projectId}`)).body;
      // Bride, pickup, plus-one, guest count (the date is hidden), shared arrangements.
      expect(brief.pendingChanges.map((c) => c.change)).toEqual(['added', 'added', 'added', 'added', 'added']);
      expect(brief.pendingChanges.some((c) => c.fieldId === remark)).toBe(false);

      const email = (await db('customer_accounts').where({ id: customerId }).first()).email;
      const res = await admin('post', `/projects/${projectId}/notify`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ changes: 5 });
      const [mail] = await mails(email);
      const data = JSON.parse(mail.email_data);
      expect(Object.keys(data).filter((k) => !k.startsWith('__') && k !== 'eventId').sort())
        .toEqual([...migration.TEMPLATE_VARIABLES].sort());
      expect(data).toMatchObject({ brief_title: 'Anna & Ben', customer_name: 'Anna', portal_link: expect.stringMatching(/\/customer\/agreements$/) });
      expect(data.brief_changes_html).toContain('Hotel Rose');
      expect(data.brief_changes_text).toContain('- Bride\'s name: Anna (added)');
      expect(mail.email_data).not.toContain('HIDDEN-REMARK');
      expect(mail.email_data).not.toContain('INTERNAL-PROJECT-NOTE');

      const after = (await admin('get', `/projects/${projectId}`)).body.brief;
      expect(after.pendingChanges).toEqual([]);
      expect(after.notifiedAt).toBeTruthy();
      expect((await admin('post', `/projects/${projectId}/notify`)).body.code).toBe('BRIEF_NOTHING_TO_SEND');
    });

    it('lists old → new, added and removed against the last update, and ignores hidden edits', async () => {
      const remark = (await admin('get', '/templates')).body.templates.global.find((f) => f.label === 'Internal remark').id;
      await admin('put', `/projects/${projectId}`).send({ values: { [remark]: { value: 'STILL-HIDDEN' } } });
      expect((await admin('get', `/projects/${projectId}`)).body.brief.pendingChanges).toEqual([]);

      const bride = await fieldId('Bride\'s name');
      const plusOne = await fieldId('Plus-one allowed until');
      const groom = await fieldId('Groom\'s name');
      await admin('put', `/projects/${projectId}`).send({
        values: { [bride]: { value: 'Anna Maria' }, [plusOne]: { visible: false }, [groom]: { value: 'Ben' } },
      });
      const pending = (await admin('get', `/projects/${projectId}`)).body.brief.pendingChanges;
      expect(pending.map((c) => [c.label, c.change])).toEqual([
        ['Bride\'s name', 'changed'], ['Groom\'s name', 'added'], ['Plus-one allowed until', 'removed'],
      ]);
      const email = (await db('customer_accounts').where({ id: customerId }).first()).email;
      await admin('post', `/projects/${projectId}/notify`);
      const data = JSON.parse((await mails(email).orderBy('id', 'desc').first()).email_data);
      expect(data.brief_changes_text.split('\n')).toEqual([
        '- Bride\'s name: Anna -> Anna Maria', '- Groom\'s name: Ben (added)', '- Plus-one allowed until: 01/05/2027 (removed)',
      ]);
      expect(data.brief_changes_html).toContain('<s>Anna</s> &rarr; Anna Maria');
    });

    it('keeps values readable when the template changes, and only lets them be cleared', async () => {
      const wedding = await weddingFields();
      const groom = wedding.find((f) => f.label === 'Groom\'s name');
      const kept = wedding.filter((f) => f.id !== groom.id).map((f) => (f.label === 'Bride\'s name' ? { ...f, label: 'Partner 1' } : f));
      expect((await admin('put', '/templates/wedding').send({ fields: kept })).status).toBe(200);

      const { fields } = (await admin('get', `/projects/${projectId}`)).body.brief;
      expect(fields.find((f) => f.label === 'Partner 1').value).toBe('Anna Maria');
      expect(fields.find((f) => f.id === groom.id)).toMatchObject({ source: 'removed', value: 'Ben', label: 'Groom\'s name' });
      expect((await admin('put', `/projects/${projectId}`).send({ values: { [groom.id]: { value: 'Benjamin' } } })).status).toBe(400);
      // The customer stops seeing it: the next update lists it as removed.
      expect((await admin('get', `/projects/${projectId}`)).body.brief.pendingChanges)
        .toEqual([expect.objectContaining({ fieldId: groom.id, change: 'removed' })]);
      expect((await admin('put', `/projects/${projectId}`).send({ values: { [groom.id]: { value: null } } })).status).toBe(200);
      expect((await admin('get', `/projects/${projectId}`)).body.brief.fields.some((f) => f.id === groom.id)).toBe(false);
    });

    it('refuses to notify without a customer', async () => {
      const lonely = await project(null);
      await admin('put', `/projects/${lonely}`).send({ sharedArrangements: 'Hi' });
      const res = await admin('post', `/projects/${lonely}/notify`);
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('BRIEF_NO_CUSTOMER');
    });
  });

  describe('a customer brief', () => {
    let customerId;
    beforeAll(async () => { customerId = await customer({ preferred_language: 'de' }); });

    it('shows the global fields only until an occasion is picked', async () => {
      const before = (await admin('get', `/customers/${customerId}`)).body.brief;
      expect(before.fields.every((f) => f.source === 'global')).toBe(true);
      expect(before.occasion).toBeNull();
      const res = await admin('put', `/customers/${customerId}`).send({ occasion: 'wedding' });
      expect(res.body.brief.occasion).toBe('wedding');
      // Without a project the project fields are ordinary values.
      const date = res.body.brief.fields.find((f) => f.type === 'project_date');
      expect(date.fromProject).toBe(false);
      const saved = await admin('put', `/customers/${customerId}`).send({ values: { [date.id]: { value: '2027-09-09' } } });
      expect(saved.body.brief.fields.find((f) => f.id === date.id).value).toBe('2027-09-09');
      expect((await admin('put', `/customers/${customerId}`).send({ occasion: 'nope' })).status).toBe(404);
    });

    it('takes no occasion on a project brief', async () => {
      const p = await project(customerId);
      expect((await admin('put', `/projects/${p}`).send({ occasion: 'birthday' })).status).toBe(200);
      expect((await admin('get', `/projects/${p}`)).body.brief.occasion).toBe('wedding');
    });

    it('needs customers.edit to save and notify', async () => {
      expect((await admin('get', `/customers/${customerId}`, viewer)).status).toBe(200);
      expect((await admin('put', `/customers/${customerId}`, viewer).send({ sharedArrangements: 'x' })).status).toBe(403);
      expect((await admin('post', `/customers/${customerId}/notify`, viewer)).status).toBe(403);
    });

    it('mails in the customer\'s language', async () => {
      const email = (await db('customer_accounts').where({ id: customerId }).first()).email;
      expect((await admin('post', `/customers/${customerId}/notify`)).status).toBe(200);
      const data = JSON.parse((await mails(email).first()).email_data);
      expect(data.__language).toBe('de');
      expect(data.brief_title).toBe('Wedding');
      expect(data.brief_changes_text).toBe('- Hochzeitsdatum: 09.09.2027 (neu)');
    });
  });

  describe('the portal', () => {
    let anna; let ben; let projectId;
    beforeAll(async () => {
      anna = await customer();
      ben = await customer();
      projectId = await project(anna);
      const remark = (await admin('get', '/templates')).body.templates.global.find((f) => f.label === 'Internal remark').id;
      const pickup = await fieldId('Bride pickup');
      await admin('put', `/projects/${projectId}`).send({
        values: { [remark]: { value: 'HIDDEN-VALUE' }, [pickup]: { value: { place: 'Hotel Rose', address: '', time: '10:00' } } },
        sharedArrangements: 'Shared text',
      });
    });

    it('shows nothing before the first update', async () => {
      expect((await portal(anna)).status).toBe(403);
    });

    it('shows the sent state: visible fields only, no notes, nobody else\'s brief', async () => {
      await admin('post', `/projects/${projectId}/notify`);
      // A later edit is not shown until the next update.
      const pickup = await fieldId('Bride pickup');
      await admin('put', `/projects/${projectId}`).send({ values: { [pickup]: { value: { place: 'UNSENT-PLACE', address: '', time: '' } } } });

      const res = await portal(anna);
      expect(res.status).toBe(200);
      expect(res.body.agreements).toHaveLength(1);
      const [agreement] = res.body.agreements;
      expect(agreement).toMatchObject({ title: 'Anna & Ben', sharedArrangements: 'Shared text', price: null, deposit: null });
      expect(agreement.fields.map((f) => f.label)).toEqual(['Wedding date', 'Bride pickup', 'Guest count']);
      const body = JSON.stringify(res.body);
      for (const secret of ['HIDDEN-VALUE', 'Internal remark', 'INTERNAL-PROJECT-NOTE', 'INTERNAL-CUSTOMER-NOTE', 'UNSENT-PLACE']) {
        expect(body).not.toContain(secret);
      }

      expect((await portal(ben)).status).toBe(403);
      await admin('put', `/customers/${ben}`).send({ sharedArrangements: 'Ben only' });
      await admin('post', `/customers/${ben}/notify`);
      const other = await portal(ben);
      expect(other.body.agreements.map((a) => a.sharedArrangements)).toEqual(['Ben only']);
      expect(JSON.stringify(other.body)).not.toContain('Hotel Rose');
      expect((await portal(anna)).body.agreements).toHaveLength(1);
    });

    it('reads price and deposit from the project\'s accepted quote and deposit invoice', async () => {
      await setFeatureFlags(db, { quotes: true, bills: true });
      const { upsertAppSetting } = require('../../src/utils/appSettings');
      await upsertAppSetting('customer_feature_quotes_enabled', 'true', 'customer_surface');
      await upsertAppSetting('customer_feature_bills_enabled', 'true', 'customer_surface');
      const deal = uuid();
      await db('quotes').insert({
        quote_number: 'Q-2678', customer_account_id: anna, status: 'accepted', currency: 'CHF', issue_date: '2027-01-01',
        net_amount_minor: 450000, vat_amount_minor: 0, shipping_amount_minor: 0, total_amount_minor: 450000,
        deal_uuid: deal, project_id: projectId, created_by_admin_id: superAdmin, accepted_at: new Date().toISOString(),
      });
      for (const [index, status] of [[1, 'paid'], [2, 'scheduled']]) {
        await db('invoices').insert({
          invoice_number: `I-2678-${index}`, customer_account_id: anna, issue_date: '2027-01-02', due_date: '2027-01-31',
          status, currency: 'CHF', net_amount_minor: 135000, vat_amount_minor: 0, total_amount_minor: 135000,
          created_by_admin_id: superAdmin, deal_uuid: deal, project_id: projectId,
          installment_index: index, installment_total: 2,
        });
      }
      const [agreement] = (await portal(anna)).body.agreements;
      expect(agreement.price).toEqual({ quoteNumber: 'Q-2678', totalMinor: 450000, currency: 'CHF' });
      expect(agreement.deposit).toEqual({ invoiceNumber: 'I-2678-1', totalMinor: 135000, currency: 'CHF', dueDate: '2027-01-31', paid: true });

      // A login without the quotes right sees no price.
      await db('customer_accounts').where({ id: anna }).update({ feature_quotes: 0 });
      expect((await portal(anna)).body.agreements[0].price).toBeNull();
      await db('customer_accounts').where({ id: anna }).update({ feature_quotes: 1 });
    });

    it('goes with the project and with an erased customer', async () => {
      const projectService = require('../../src/services/projectService');
      await projectService.deleteProject(projectId);
      expect(await db('project_briefs').where({ project_id: projectId }).first()).toBeUndefined();

      const carla = await customer();
      const p = await project(carla);
      await admin('put', `/projects/${p}`).send({ sharedArrangements: 'x' });
      await admin('put', `/customers/${carla}`).send({ sharedArrangements: 'y' });
      await require('../../src/services/customerAccountsService').eraseCustomer(carla, superAdmin);
      expect(await db('project_briefs').where({ project_id: p }).orWhere({ customer_account_id: carla }).first()).toBeUndefined();
    });
  });
});
