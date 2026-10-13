'use strict';

/**
 * Internal expenses and incoming invoices follow the per-admin owner rule
 * (services/expenseAccess.js): an admin reaches what they recorded, what is
 * booked to a gallery they created, and intake nobody has triaged; a super
 * admin reaches everything. Through the real router and adminAuth.
 */

const request = require('supertest');
const { bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp } = require('./helpers/crmDb');
const formatBoolean = value => require('../../src/utils/dbCompat').formatBoolean(value);

let db, cleanup, ownerId, otherId, superId, customerId, app, tokens, ownEvent, otherEvent;
const idOf = r => Number(r[0]?.id ?? r[0]);
const auth = who => ({ Authorization: `Bearer ${tokens[who]}` });
const api = (who, method, url) => request(app)[method](`/api/admin/expenses${url}`).set(auth(who));

async function addEvent(slug, createdBy) {
  return idOf(await db('events').insert({
    slug, event_type: 'other', event_name: slug, event_date: '2026-07-03',
    host_email: 'h@example.test', admin_email: 'a@example.test', password_hash: 'x',
    share_link: `/gallery/${slug}/s`, share_token: `${slug}-share`,
    expires_at: new Date(Date.now() + 30 * 864e5).toISOString(),
    is_active: formatBoolean(true), is_archived: formatBoolean(false), created_by: createdBy,
    created_at: new Date().toISOString(),
  }).returning('id'));
}
const addExpense = (createdBy, eventId, description) => db('expenses').insert({
  disposition: 'eigener_aufwand', kind: 'amount', event_id: eventId, description,
  supplier_name: 'Supplier', original_currency: 'CHF', original_amount_minor: 1000, chf_amount_minor: 1000,
  created_by_admin_id: createdBy,
}).returning('id').then(idOf);
const addInbound = (createdBy, eventId, supplier, extra = {}) => db('inbound_documents').insert({
  source: createdBy ? 'upload' : 'email', supplier_name: supplier, event_id: eventId,
  total_amount_minor: 5000, currency: 'CHF', created_by_admin_id: createdBy, ...extra,
}).returning('id').then(idOf);

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  ({ adminId: ownerId, customerId } = await seedMinimal(db));
  const roleId = idOf(await db('roles').insert({ name: 'accounting_ownership_test', display_name: 'Photographer with accounting' }).returning('id'));
  const permissions = await db('permissions').whereIn('name', ['accounting.view', 'accounting.manage', 'bills.view', 'bills.manage']);
  expect(permissions).toHaveLength(4);
  await db('role_permissions').insert(permissions.map(p => ({ role_id: roleId, permission_id: p.id })));
  await db('admin_users').where('id', ownerId).update({ role_id: roleId, is_active: formatBoolean(true) });
  otherId = idOf(await db('admin_users').insert({ username: 'other-photographer', email: 'other@example.test', password_hash: 'unused',
    role_id: roleId, is_active: formatBoolean(true), must_change_password: formatBoolean(false) }).returning('id'));
  superId = idOf(await db('admin_users').insert({ username: 'studio-superadmin', email: 'studio@example.test', password_hash: 'unused',
    is_active: formatBoolean(true), must_change_password: formatBoolean(false) }).returning('id'));
  await assignAdminRole(db, superId);
  require('../../src/middleware/permissions').clearPermissionCache();
  for (const key of ['accounting', 'expenses', 'incomingInvoices', 'bills']) {
    if (await db('feature_flags').where({ key }).first()) await db('feature_flags').where({ key }).update({ value: formatBoolean(true) });
    else await db('feature_flags').insert({ key, value: formatBoolean(true) });
  }
  ownEvent = await addEvent('own-gallery', ownerId);
  otherEvent = await addEvent('other-gallery', otherId);
  tokens = { owner: mintAdminToken(ownerId), other: mintAdminToken(otherId), super: mintAdminToken(superId) };
  app = buildRouteApp('/api/admin/expenses', require('../../src/routes/adminExpenses'));
});
afterAll(async () => { if (cleanup) await cleanup(); });

describe('internal expenses', () => {
  let mine, theirs, theirsOnMyEvent;
  beforeAll(async () => {
    mine = await addExpense(ownerId, null, 'mine, company');
    theirs = await addExpense(otherId, otherEvent, 'theirs, their gallery');
    theirsOnMyEvent = await addExpense(otherId, ownEvent, 'theirs, booked to my gallery');
  });

  it('lists only what the admin recorded or what is booked to their gallery', async () => {
    const list = await api('owner', 'get', '');
    expect(list.status).toBe(200);
    expect(list.body.items.map(e => e.id).sort()).toEqual([mine, theirsOnMyEvent].sort());
    expect(list.body.pagination.total).toBe(2);
    const all = await api('super', 'get', '');
    expect(all.body.items.map(e => e.id)).toEqual(expect.arrayContaining([mine, theirs, theirsOnMyEvent]));
  });

  it('answers 404 on another admin\'s expense: detail, history, proof, edit, paid, invoice', async () => {
    await db('expenses').where({ id: theirs }).update({ receipt_path: 'business-docs/x.pdf' });
    expect((await api('owner', 'get', `/${theirs}`)).status).toBe(404);
    expect((await api('owner', 'get', `/${theirs}/history`)).status).toBe(404);
    expect((await api('owner', 'get', `/${theirs}/proof`)).status).toBe(404);
    expect((await api('owner', 'patch', `/${theirs}`).field('description', 'rewritten')).status).toBe(404);
    expect((await api('owner', 'post', `/${theirs}/paid`).send({ paid: true })).status).toBe(404);
    expect((await api('owner', 'post', `/${theirs}/invoice`).send({ customerAccountId: customerId })).status).toBe(404);
    expect((await db('expenses').where({ id: theirs }).first()).description).toBe('theirs, their gallery');
    expect((await api('other', 'get', `/${theirs}`)).status).toBe(200);
    expect((await api('super', 'get', `/${theirs}`)).status).toBe(200);
  });

  it('refuses booking an expense to a gallery the admin did not create', async () => {
    const forged = await api('owner', 'post', '').field('eventId', String(otherEvent)).field('supplierName', 'Forged')
      .field('description', 'planted').field('amountMinor', '99900');
    expect(forged.status).toBe(403);
    expect(forged.body.code || forged.body.error?.code).toBe('EVENT_NOT_YOURS');
    expect(await db('expenses').where({ description: 'planted' }).first()).toBeUndefined();

    const moved = await api('owner', 'patch', `/${mine}`).field('eventId', String(otherEvent));
    expect(moved.status).toBe(403);
    expect((await db('expenses').where({ id: mine }).first()).event_id).toBeNull();

    const own = await api('owner', 'post', '').field('eventId', String(ownEvent)).field('supplierName', 'Real')
      .field('description', 'own gallery').field('amountMinor', '1200');
    expect(own.status).toBe(201);
    const bySuper = await api('super', 'post', '').field('eventId', String(otherEvent)).field('supplierName', 'Studio')
      .field('description', 'super admin books anywhere').field('amountMinor', '1200');
    expect(bySuper.status).toBe(201);
  });

  it('refuses an edit that would take the expense out of the caller\'s reach, and saves none of it', async () => {
    const res = await api('owner', 'patch', `/${theirsOnMyEvent}`).field('eventId', '').field('description', 'moved to company');
    expect(res.status).toBe(409);
    expect(res.body.code || res.body.error?.code).toBe('ACCESS_THROUGH_EVENT_ONLY');
    const row = await db('expenses').where({ id: theirsOnMyEvent }).first();
    expect([Number(row.event_id), row.description]).toEqual([Number(ownEvent), 'theirs, booked to my gallery']);

    // Everything that keeps it on the caller's gallery still works, paying included.
    expect((await api('owner', 'patch', `/${theirsOnMyEvent}`).field('description', 'edited by the gallery owner')).status).toBe(200);
    expect((await api('owner', 'post', `/${theirsOnMyEvent}/paid`).send({ paid: true })).status).toBe(200);
    // The recorder and a super admin may move it to the company.
    expect((await api('other', 'patch', `/${theirsOnMyEvent}`).field('eventId', '')).status).toBe(200);
    expect((await db('expenses').where({ id: theirsOnMyEvent }).first()).event_id).toBeNull();
    // Their own record stays theirs without a gallery.
    const own = await addExpense(ownerId, ownEvent, 'mine, my gallery');
    expect((await api('owner', 'patch', `/${own}`).field('eventId', '')).status).toBe(200);
  });
});

describe('incoming invoices', () => {
  let mine, theirs, untriaged;
  beforeAll(async () => {
    mine = await addInbound(ownerId, null, 'Mine AG');
    theirs = await addInbound(otherId, null, 'Theirs AG', { file_path: 'business-docs/t.pdf', mime_type: 'application/pdf' });
    untriaged = await addInbound(null, null, 'Mailbox AG');
  });

  it('lists the admin\'s own and the untriaged intake, not another admin\'s', async () => {
    const list = await api('owner', 'get', '/inbound');
    expect(list.status).toBe(200);
    expect(list.body.items.map(d => d.id).sort()).toEqual([mine, untriaged].sort());
    expect((await api('super', 'get', '/inbound')).body.items.map(d => d.id))
      .toEqual(expect.arrayContaining([mine, theirs, untriaged]));
  });

  it('answers 404 on another admin\'s incoming invoice: detail, history, file, page, edit, categorize, payment', async () => {
    for (const [method, url, body] of [
      ['get', `/inbound/${theirs}`], ['get', `/inbound/${theirs}/history`], ['get', `/inbound/${theirs}/file`],
      ['get', `/inbound/${theirs}/page/1`], ['patch', `/inbound/${theirs}`, { note: 'x' }],
      ['post', `/inbound/${theirs}/categorize`, { disposition: 'eigener_aufwand' }],
      ['post', `/inbound/${theirs}/supplier-payment`, { paid: true }],
      ['post', `/inbound/${theirs}/rebill`, { customerAccountId: customerId }],
    ]) {
      const res = body ? await api('owner', method, url).send(body) : await api('owner', method, url);
      expect([method, url, res.status]).toEqual([method, url, 404]);
    }
    expect((await db('inbound_documents').where({ id: theirs }).first()).status).toBe('unsorted');
    expect((await api('other', 'get', `/inbound/${theirs}`)).status).toBe(200);
  });

  it('refuses booking an incoming invoice to a foreign gallery', async () => {
    const res = await api('owner', 'post', `/inbound/${mine}/categorize`).send({ disposition: 'durchlaufend', eventId: otherEvent });
    expect(res.status).toBe(403);
    expect((await db('inbound_documents').where({ id: mine }).first()).event_id).toBeNull();
  });

  it('hands untriaged intake to whoever categorises it', async () => {
    expect((await api('other', 'get', `/inbound/${untriaged}`)).status).toBe(200);
    const res = await api('owner', 'post', `/inbound/${untriaged}/categorize`).send({ disposition: 'eigener_aufwand' });
    expect(res.status).toBe(200);
    expect(Number((await db('inbound_documents').where({ id: untriaged }).first()).created_by_admin_id)).toBe(Number(ownerId));
    expect((await api('other', 'get', `/inbound/${untriaged}`)).status).toBe(404);
    expect((await api('owner', 'get', `/inbound/${untriaged}`)).status).toBe(200);
  });

  it('refuses a categorisation that would take the invoice out of the caller\'s reach, so "save and mark paid" never half-completes', async () => {
    const theirsOnMine = await addInbound(otherId, ownEvent, 'Theirs on my gallery');
    for (const disposition of ['eigener_aufwand', 'abgelehnt', 'durchlaufend']) {
      const res = await api('owner', 'post', `/inbound/${theirsOnMine}/categorize`).send({ disposition });
      expect([disposition, res.status, res.body.code || res.body.error?.code]).toEqual([disposition, 409, 'ACCESS_THROUGH_EVENT_ONLY']);
    }
    const untouched = await db('inbound_documents').where({ id: theirsOnMine }).first();
    expect([untouched.status, untouched.disposition, Number(untouched.event_id)]).toEqual(['unsorted', null, Number(ownEvent)]);

    const kept = await api('owner', 'post', `/inbound/${theirsOnMine}/categorize`).send({ disposition: 'durchlaufend', eventId: ownEvent });
    expect(kept.status).toBe(200);
    expect((await api('owner', 'post', `/inbound/${theirsOnMine}/supplier-payment`).send({ paid: true })).status).toBe(200);
    expect((await api('other', 'post', `/inbound/${theirsOnMine}/categorize`).send({ disposition: 'eigener_aufwand' })).status).toBe(200);
  });

  it('keeps the customer panel and the pending pool to the admin\'s own documents', async () => {
    const pending = { disposition: 'rebill', status: 'categorized', customer_account_id: customerId };
    const minePending = await addInbound(ownerId, null, 'Mine pending', pending);
    const theirsPending = await addInbound(otherId, null, 'Theirs pending', pending);
    const panel = await api('owner', 'get', `/inbound/by-customer/${customerId}`);
    expect(panel.status).toBe(200);
    expect(panel.body.items.map(d => d.id)).toEqual([minePending]);
    const superPanel = await api('super', 'get', `/inbound/by-customer/${customerId}`);
    expect(superPanel.body.items.map(d => d.id).sort()).toEqual([minePending, theirsPending].sort());
    const summary = await api('owner', 'get', '/inbound/pending-summary');
    expect(summary.status).toBe(200);
    expect(summary.body.items.map(c => c.itemCount)).toEqual([1]);
  });
});

describe('system jobs', () => {
  it('are not narrowed: with no admin on the call every row is reachable', async () => {
    const service = require('../../src/services/expenseService');
    const { withTrustedCrmAccess } = require('../../src/database/crmAccess');
    const total = Number((await db('expenses').whereNull('inbound_document_id').count({ n: '*' }).first()).n);
    const listed = await withTrustedCrmAccess('test: system job', () => service.listExpenses({ pageSize: 100 }));
    expect(listed.pagination.total).toBe(total);
  });
});

describe('studio-wide reports', () => {
  it('stay refused for an admin who sees only their own documents, so no foreign cost is summed in', async () => {
    const { loadCrmActor, withCrmActor } = require('../../src/database/crmAccess');
    const { getTaxReport } = require('../../src/services/taxReportService');
    const { buildPostings } = require('../../src/services/ledgerService');
    const range = { from: '2000-01-01', to: '2100-01-01', currency: 'CHF' };
    const actor = await loadCrmActor({ id: ownerId, roleName: 'accounting_ownership_test' });
    await expect(withCrmActor(actor, () => getTaxReport(range))).rejects.toMatchObject({ code: 'CRM_COMPLETE_VIEW_REQUIRED' });
    await expect(withCrmActor(actor, () => buildPostings(range))).rejects.toMatchObject({ code: 'CRM_COMPLETE_VIEW_REQUIRED' });
  });
});
