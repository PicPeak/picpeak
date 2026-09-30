/**
 * GET /api/admin/calendar/items was gated on customers.view alone. Its events
 * query skipped scopeEventsListQuery, so a restricted role read every studio
 * event by name, date and customer, and the quote and contract sections
 * carried no quotes.view / contracts.view check and no feature-flag check.
 * The restricted role holds customers.view and quotes.view but not
 * contracts.view, and does not see all events (security review 2026-09-29).
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-calscope-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'calscope-test-secret';
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-calscope-storage-'));

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const { bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken } = require('../integration/helpers/crmDb');
const { clearPermissionCache } = require('../../src/middleware/permissions');
const { invalidateFeatureFlagCache } = require('../../src/middleware/requireFeatureFlag');

const FROM = '2026-08-01';
const TO = '2026-08-31';

describe('admin calendar — scoped to what the role may see', () => {
  let db; let cleanup; let app; let customerId;
  const tok = {};
  const as = (who) => request(app).get(`/api/admin/calendar/items?from=${FROM}&to=${TO}`)
    .set('Authorization', `Bearer ${tok[who]}`);
  const now = () => new Date().toISOString();

  // stable has no team_photographer preset (main's migration 175), so the
  // restricted role is created here: sees its own events, may read customers
  // and quotes, may not read contracts.
  async function createRole(name, permissionNames) {
    const rows = await db('roles').insert({
      name, display_name: name, description: 'test role', is_system: false, priority: 10,
    }).returning('id');
    const roleId = rows[0]?.id ?? rows[0];
    const permissions = await db('permissions').whereIn('name', permissionNames).select('id');
    expect(permissions).toHaveLength(permissionNames.length);
    for (const permission of permissions) {
      await db('role_permissions').insert({ role_id: roleId, permission_id: permission.id });
    }
  }

  async function mkAdmin(name, roleName) {
    const rows = await db('admin_users').insert({
      username: `calscope-${name}`, email: `calscope-${name}@example.com`,
      password_hash: 'x', must_change_password: false, created_at: now(),
    }).returning('id');
    const adminId = rows[0]?.id ?? rows[0];
    await assignAdminRole(db, adminId, roleName);
    tok[name] = mintAdminToken(adminId);
    return adminId;
  }
  async function mkEvent(slug, createdBy) {
    await db('events').insert({
      slug, event_type: 'wedding', event_name: slug, event_date: '2026-08-10',
      host_email: 'h@example.com', admin_email: 'a@example.com', password_hash: 'x',
      share_token: `st-${slug}`, share_link: `/gallery/${slug}/st-${slug}`,
      created_by: createdBy, expires_at: new Date(Date.now() + 30 * 864e5).toISOString(),
      is_active: 1, is_archived: 0, is_draft: 0, created_at: now(),
    });
  }
  async function setFlag(key, value) {
    await db('feature_flags').insert({ key, value }).onConflict('key').merge({ value });
    invalidateFeatureFlagCache();
  }

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    const seeded = await seedMinimal(db);
    customerId = seeded.customerId;
    await assignAdminRole(db, seeded.adminId, 'super_admin');
    tok.super = mintAdminToken(seeded.adminId);
    await createRole('cal-photographer', ['events.view', 'customers.view', 'quotes.view']);
    const ownerId = await mkAdmin('owner', 'cal-photographer');
    const otherId = await mkAdmin('other', 'cal-photographer');
    clearPermissionCache();

    await mkEvent('mine', ownerId);
    await mkEvent('theirs', otherId);
    await db('quotes').insert({
      quote_number: 'Q-CAL-1', customer_account_id: customerId, status: 'sent',
      issue_date: '2026-07-01', event_date: '2026-08-12', event_name: 'Quoted shoot',
    });
    await db('contracts').insert({
      contract_number: 'C-CAL-1', customer_account_id: customerId, status: 'signed_by_customer',
      issue_date: '2026-07-01', event_date: '2026-08-14', event_name: 'Contracted shoot',
    });
    await setFlag('calendar', true);
    await setFlag('quotes', true);
    await setFlag('contracts', true);
    await setFlag('hoursLogging', true);

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/admin/calendar', require('../../src/routes/adminCalendar'));
  }, 120000);
  afterAll(async () => { if (cleanup) await cleanup(); });

  const kinds = (body, kind) => body.items.filter((i) => i.kind === kind);

  it('shows a super admin everything', async () => {
    const res = await as('super');
    expect(res.status).toBe(200);
    expect(kinds(res.body, 'event').map((e) => e.slug).sort()).toEqual(['mine', 'theirs']);
    expect(kinds(res.body, 'quote').map((q) => q.quoteNumber)).toEqual(['Q-CAL-1']);
    expect(kinds(res.body, 'contract').map((c) => c.contractNumber)).toEqual(['C-CAL-1']);
  });

  it('shows a restricted role only its own events', async () => {
    const res = await as('owner');
    expect(res.status).toBe(200);
    expect(kinds(res.body, 'event').map((e) => e.slug)).toEqual(['mine']);
  });

  it('withholds contracts from a role without contracts.view, while quotes.view still shows quotes', async () => {
    const res = await as('owner');
    expect(kinds(res.body, 'contract')).toEqual([]);
    expect(kinds(res.body, 'quote').map((q) => q.quoteNumber)).toEqual(['Q-CAL-1']);
  });

  it('withholds quotes once the quotes feature is off, even for a super admin', async () => {
    await setFlag('quotes', false);
    try {
      const res = await as('super');
      expect(kinds(res.body, 'quote')).toEqual([]);
      expect(kinds(res.body, 'contract').map((c) => c.contractNumber)).toEqual(['C-CAL-1']);
    } finally {
      await setFlag('quotes', true);
    }
  });
});
