/**
 * Layered per-event category ordering (#782).
 *
 * Two ordering layers, resolved per event:
 *   - GLOBAL default   — photo_categories.display_order (migration 159),
 *                        set via POST /reorder-global; applies everywhere.
 *   - PER-EVENT override — event_category_order (migration 160), set via
 *                        POST /reorder; overrides the default for one gallery.
 *   - DELETE /reorder/:eventId clears an event's override.
 *
 * Verified against a real SQLite DB with the full core-migration set applied.
 */
const request = require('supertest');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp,
} = require('./helpers/crmDb');

jest.setTimeout(120000);

describe('category ordering (#782)', () => {
  let db;
  let cleanup;
  let token;
  let app;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    const { adminId } = await seedMinimal(db);
    await assignAdminRole(db, adminId, 'super_admin');
    token = mintAdminToken(adminId);
    app = buildRouteApp('/api/admin/categories', require('../../src/routes/adminCategories'));
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  const auth = (r) => r.set('Authorization', `Bearer ${token}`);

  async function insertEvent(slug) {
    await db('events').insert({
      event_type: 'wedding', password_hash: 'x',
      expires_at: new Date(Date.now() + 9e9).toISOString(),
      is_active: true, is_archived: false, slug, share_link: slug,
      event_name: slug, event_date: '2026-01-01',
    });
    return (await db('events').where({ slug }).first()).id;
  }

  async function insertCat(name, { is_global = false, event_id = null, display_order = 0 } = {}) {
    const res = await db('photo_categories').insert({
      name,
      slug: name.toLowerCase().replace(/\s+/g, '-'),
      is_global: is_global ? 1 : 0,
      event_id,
      display_order,
    }).returning('id');
    return res[0]?.id ?? res[0];
  }

  const getEvent = (eventId) => auth(request(app).get(`/api/admin/categories/event/${eventId}`)).expect(200);

  describe('migration 159 backfill', () => {
    it('seeds display_order from alphabetical order, scoped per event', async () => {
      const eventId = await insertEvent('backfill-ev');
      await insertCat('Reception', { event_id: eventId });
      await insertCat('Ceremony', { event_id: eventId });
      await insertCat('Pre-Ceremony', { event_id: eventId });

      // Re-run the migration: addColumn is guarded (no-op); the backfill loop
      // re-runs and assigns per-scope alphabetical order — what an upgrade does.
      await require('../../migrations/core/159_add_category_display_order').up(db);

      const evCats = await db('photo_categories').where({ event_id: eventId }).orderBy('display_order', 'asc');
      expect(evCats.map((c) => c.name)).toEqual(['Ceremony', 'Pre-Ceremony', 'Reception']);
      expect(evCats.map((c) => c.display_order)).toEqual([1, 2, 3]);
    });
  });

  describe('global default order (POST /reorder-global)', () => {
    it('reverses the global order and every non-customised event follows it', async () => {
      const before = (await auth(request(app).get('/api/admin/categories/global')).expect(200)).body;
      expect(before.length).toBeGreaterThan(1);
      const reversedIds = before.map((c) => c.id).reverse();

      const res = await auth(request(app).post('/api/admin/categories/reorder-global'))
        .send({ orderedIds: reversedIds })
        .expect(200);
      expect(res.body.map((c) => c.id)).toEqual(reversedIds);

      // A fresh event (no override) shows globals in the new global order.
      const eventId = await insertEvent('follows-global');
      const globalsInEvent = (await getEvent(eventId)).body.filter((c) => c.is_global).map((c) => c.id);
      expect(globalsInEvent).toEqual(reversedIds);
    });
  });

  describe('per-event override (POST /reorder)', () => {
    it('pins a custom order for one event without affecting another', async () => {
      const eventA = await insertEvent('override-a');
      const eventB = await insertEvent('override-b');
      const a1 = await insertCat('A-Ceremony', { event_id: eventA });
      const a2 = await insertCat('A-Reception', { event_id: eventA });

      // Current resolved list for A (globals + A's two categories).
      const listA = (await getEvent(eventA)).body;
      // Put A-Reception first, then A-Ceremony, then the globals in their order.
      const globalsA = listA.filter((c) => c.is_global).map((c) => c.id);
      const desired = [a2, a1, ...globalsA];

      const res = await auth(request(app).post('/api/admin/categories/reorder'))
        .send({ event_id: eventA, orderedIds: desired })
        .expect(200);
      expect(res.body.map((c) => c.id)).toEqual(desired);
      // override_position is set on every row for a customised event.
      expect(res.body.every((c) => c.override_position != null)).toBe(true);

      // Event B is untouched — no override, follows the global default.
      const listB = (await getEvent(eventB)).body;
      expect(listB.every((c) => c.override_position == null)).toBe(true);
    });

    it('accepts global ids but rejects another event’s category', async () => {
      const eventId = await insertEvent('scope-ev');
      const own = await insertCat('Own', { event_id: eventId });
      const global = (await db('photo_categories').where('is_global', 1).first()).id;
      const foreign = await insertCat('Foreign', { event_id: await insertEvent('other-ev') });

      // A global id is allowed (globals can be arranged per event).
      await auth(request(app).post('/api/admin/categories/reorder'))
        .send({ event_id: eventId, orderedIds: [own, global] })
        .expect(200);

      // A foreign event's category is out of scope.
      await auth(request(app).post('/api/admin/categories/reorder'))
        .send({ event_id: eventId, orderedIds: [own, foreign] })
        .expect(400);
    });
  });

  describe('reset (DELETE /reorder/:eventId)', () => {
    it('clears the override and reverts to the global default', async () => {
      const eventId = await insertEvent('reset-ev');
      const c1 = await insertCat('R-One', { event_id: eventId });
      const list = (await getEvent(eventId)).body;
      const globals = list.filter((c) => c.is_global).map((c) => c.id);

      await auth(request(app).post('/api/admin/categories/reorder'))
        .send({ event_id: eventId, orderedIds: [c1, ...globals] })
        .expect(200);
      expect((await getEvent(eventId)).body.some((c) => c.override_position != null)).toBe(true);

      const res = await auth(request(app).delete(`/api/admin/categories/reorder/${eventId}`)).expect(200);
      expect(res.body.every((c) => c.override_position == null)).toBe(true);
      expect(await db('event_category_order').where({ event_id: eventId }).first()).toBeUndefined();
    });
  });

  describe('event ownership (PR #790 review)', () => {
    let limitedToken;
    let foreignEventId;

    beforeAll(async () => {
      const bcrypt = require('bcrypt');
      // A non-super_admin role that DOES hold settings.view + settings.edit —
      // the exact case the review flagged (settings.edit is grantable).
      const roleRes = await db('roles').insert({ name: 'gallery-mgr', display_name: 'Gallery Mgr' }).returning('id');
      const roleId = roleRes[0]?.id ?? roleRes[0];
      const permIds = await db('permissions').whereIn('name', ['settings.view', 'settings.edit']).pluck('id');
      await db('role_permissions').insert(permIds.map((permission_id) => ({ role_id: roleId, permission_id })));

      const a2 = await db('admin_users').insert({
        username: 'limited', email: 'limited@example.com',
        password_hash: await bcrypt.hash('x', 4), role_id: roleId,
        must_change_password: false, created_at: new Date(),
      }).returning('id');
      limitedToken = mintAdminToken(a2[0]?.id ?? a2[0]);

      // An event owned by a DIFFERENT admin (the seeded super_admin).
      const owner = (await db('admin_users').where({ username: 'tester' }).first()).id;
      await db('events').insert({
        event_type: 'wedding', password_hash: 'x',
        expires_at: new Date(Date.now() + 9e9).toISOString(),
        is_active: true, is_archived: false, slug: 'owned-ev', share_link: 'owned-ev',
        event_name: 'Owned', event_date: '2026-01-01', created_by: owner,
      });
      foreignEventId = (await db('events').where({ slug: 'owned-ev' }).first()).id;
    });

    const limitedAuth = (r) => r.set('Authorization', `Bearer ${limitedToken}`);

    it('blocks a non-owner from reading, reordering or resetting another event', async () => {
      await limitedAuth(request(app).get(`/api/admin/categories/event/${foreignEventId}`)).expect(403);
      await limitedAuth(request(app).post('/api/admin/categories/reorder'))
        .send({ event_id: foreignEventId, orderedIds: [1] }).expect(403);
      await limitedAuth(request(app).delete(`/api/admin/categories/reorder/${foreignEventId}`)).expect(403);
    });
  });

  describe('POST / (create) appends to the end of its scope', () => {
    it('assigns display_order = max + 1 within the event', async () => {
      const eventId = await insertEvent('append-ev');
      await insertCat('First', { event_id: eventId, display_order: 1 });
      await insertCat('Second', { event_id: eventId, display_order: 2 });

      const res = await auth(request(app).post('/api/admin/categories'))
        .send({ name: 'Third', is_global: false, event_id: eventId })
        .expect(200);

      expect(res.body.display_order).toBe(3);
    });
  });
});
