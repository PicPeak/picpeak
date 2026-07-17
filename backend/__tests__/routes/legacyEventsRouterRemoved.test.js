/**
 * Regression test for GHSA-4j34-x562-5vfq — broken access control in the legacy
 * /api/events router.
 *
 * The legacy router exposed create/list/update/delete/extend guarded by
 * adminAuth ALONE (no requirePermission, no requireEventOwnership), so any
 * back-office account — down to a read-only viewer — could read every gallery's
 * password_hash/share_token and take over any gallery. The fix removes that
 * router entirely and migrates its one UI-used route (POST /:id/extend) to the
 * canonical /api/admin/events mount, where it inherits the permission +
 * ownership guards.
 *
 * This test pins two invariants:
 *   1. The legacy source file is gone (nothing can re-mount it).
 *   2. The migrated extend route enforces ownership — a non-owning editor gets
 *      403, the owner succeeds.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-legacy-acl-')), 'db.sqlite'
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'legacy-acl-test-secret';

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const { bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken } = require('../integration/helpers/crmDb');

async function insertEvent(db, ownerId, over = {}) {
  const base = {
    slug: `ev-${Math.random().toString(16).slice(2)}`,
    event_type: 'wedding',
    event_name: 'Owner Gallery',
    event_date: '2026-05-29',
    host_email: 'host@example.com',
    admin_email: 'admin@example.com',
    password_hash: 'x',
    share_link: `/gallery/share-${Math.random().toString(16).slice(2)}`,
    share_token: `st-${Math.random().toString(16).slice(2)}`,
    expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
    is_active: 1, is_archived: 0, is_draft: 0,
    created_by: ownerId,
    created_at: new Date().toISOString(),
    ...over,
  };
  const r = await db('events').insert(base).returning('id');
  return r[0]?.id ?? r[0];
}

describe('GHSA-4j34: legacy /api/events router removed + extend guarded', () => {
  it('the legacy events router source file no longer exists', () => {
    expect(fs.existsSync(path.join(__dirname, '../../src/routes/events.js'))).toBe(false);
  });

  describe('POST /api/admin/events/:id/extend ownership enforcement', () => {
    let db; let cleanup; let app;
    let ownerId; let ownerToken;
    let editorId; let editorToken;

    beforeAll(async () => {
      ({ db, cleanup } = await bootCrmDb());
      ({ adminId: ownerId } = await seedMinimal(db));
      await assignAdminRole(db, ownerId, 'super_admin');
      ownerToken = mintAdminToken(ownerId);

      // A second, non-owning account with the low-trust editor role.
      [editorId] = await db('admin_users').insert({
        username: 'editor1', email: 'editor1@example.com',
        password_hash: 'x', is_active: 1,
      }).returning('id');
      editorId = editorId?.id ?? editorId;
      await assignAdminRole(db, editorId, 'editor');
      editorToken = mintAdminToken(editorId);

      app = express();
      app.use(express.json());
      app.use(cookieParser());
      app.use('/api/admin/events', require('../../src/routes/adminEvents'));
      // eslint-disable-next-line no-unused-vars
      app.use((err, req, res, next) => {
        res.status(err.statusCode || err.status || 500).json({ error: err.message, code: err.code });
      });
    }, 120000);

    afterAll(async () => { await cleanup(); });

    it('lets the owner extend their own gallery', async () => {
      const id = await insertEvent(db, ownerId, { expires_at: '2026-06-01T00:00:00.000Z' });
      const res = await request(app)
        .post(`/api/admin/events/${id}/extend`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ days: 10 });
      expect(res.status).toBe(200);
      expect(new Date(res.body.expires_at).toISOString()).toBe('2026-06-11T00:00:00.000Z');
    });

    it('403s a non-owning editor trying to extend someone else\'s gallery', async () => {
      const id = await insertEvent(db, ownerId); // owned by the super_admin
      const res = await request(app)
        .post(`/api/admin/events/${id}/extend`)
        .set('Authorization', `Bearer ${editorToken}`)
        .send({ days: 30 });
      expect(res.status).toBe(403); // requireEventOwnership blocks it
    });

    it('validates the days field', async () => {
      const id = await insertEvent(db, ownerId);
      const res = await request(app)
        .post(`/api/admin/events/${id}/extend`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ days: 9999 });
      expect(res.status).toBe(400);
    });
  });
});
