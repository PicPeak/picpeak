/**
 * Dashboard endpoints must not leak other admins' data to event-scoped
 * editors — GHSA-c2jj (/stats), GHSA-gqx7 (/analytics), GHSA-jhcf (/activity).
 *
 * All three are gated only by `analytics.view`, which the `editor` role holds.
 * But the events LIST restricts editors to their own rows
 * (adminEvents/crud.js: roleName === 'editor' → created_by = admin.id), so an
 * editor saw instance-wide totals — and, via /analytics topGalleries, other
 * admins' gallery names and SLUGS (the public gallery URL component) — for
 * events invisible to them everywhere else.
 *
 * Scoping deliberately keys on `editor` to mirror the events list exactly, so
 * the `admin` role's dashboard is unchanged.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-dashscope-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'dashscope-test-secret';

const request = require('supertest');
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');

describe('dashboard scoping (GHSA-c2jj / gqx7 / jhcf)', () => {
  let db; let cleanup; let app;
  let editorToken; let superToken;
  let ownEventId; let foreignEventId;

  const mkAdmin = async (username, roleName) => {
    const role = await db('roles').where({ name: roleName }).first();
    const r = await db('admin_users').insert({
      username,
      email: `${username}@example.com`,
      password_hash: await bcrypt.hash('Passw0rd!', 4),
      role_id: role.id,
      is_active: 1,
      created_at: new Date(),
      updated_at: new Date(),
    }).returning('id');
    const id = r[0]?.id ?? r[0];
    const token = jwt.sign(
      { id, username, type: 'admin', role: roleName, loginTime: Date.now() },
      process.env.JWT_SECRET,
      { expiresIn: '1h', issuer: 'picpeak-auth' },
    );
    return { id, token };
  };

  const mkEvent = async (slug, createdBy) => {
    const r = await db('events').insert({
      slug,
      event_type: 'wedding',
      event_name: `${slug}-name`,
      event_date: '2026-08-01',
      host_email: 'h@example.com',
      admin_email: 'a@example.com',
      password_hash: 'x',
      share_token: `tok-${slug}`,
      share_link: `/gallery/${slug}/tok-${slug}`,
      created_by: createdBy,
      expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
      is_active: 1, is_archived: 0, is_draft: 0,
      created_at: new Date().toISOString(),
    }).returning('id');
    return r[0]?.id ?? r[0];
  };

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);

    const editor = await mkAdmin('scoped-editor', 'editor');
    const sup = await mkAdmin('root-admin', 'super_admin');
    editorToken = editor.token;
    superToken = sup.token;

    ownEventId = await mkEvent('own-gallery', editor.id);
    foreignEventId = await mkEvent('foreign-gallery', sup.id);

    // One photo + one view per event so the aggregates are non-zero.
    for (const [eventId, name] of [[ownEventId, 'own'], [foreignEventId, 'foreign']]) {
      await db('photos').insert({
        event_id: eventId,
        filename: `${name}.jpg`,
        path: `events/active/${name}.jpg`,
        type: 'individual',
        size_bytes: 1000,
        uploaded_at: new Date().toISOString(),
      });
      await db('access_logs').insert({
        event_id: eventId,
        action: 'view',
        ip_address: `10.0.0.${eventId}`,
        user_agent: 'Mozilla/5.0',
        timestamp: new Date().toISOString(),
      });
      await db('activity_logs').insert({
        activity_type: 'photo_viewed',
        actor_type: 'admin',
        actor_name: `${name}-actor`,
        event_id: eventId,
        created_at: new Date().toISOString(),
      });
    }

    app = express();
    app.use(express.json());
    app.use('/api/admin/dashboard', require('../../src/routes/adminDashboard'));
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  it('/stats counts only the editor\'s own events and photos', async () => {
    const res = await request(app)
      .get('/api/admin/dashboard/stats')
      .set('Authorization', `Bearer ${editorToken}`);

    expect(res.status).toBe(200);
    expect(Number(res.body.totalEvents)).toBe(1);
    expect(Number(res.body.totalPhotos)).toBe(1);
    expect(Number(res.body.storageUsed)).toBe(1000);
  });

  it('/analytics does not expose a foreign gallery name or slug', async () => {
    const res = await request(app)
      .get('/api/admin/dashboard/analytics?days=7')
      .set('Authorization', `Bearer ${editorToken}`);

    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('foreign-gallery');
    expect(body).not.toContain('foreign-gallery-name');
    expect(res.body.topGalleries.map((g) => g.slug)).toEqual(['own-gallery']);
  });

  it('/activity does not surface a foreign event\'s entries', async () => {
    const res = await request(app)
      .get('/api/admin/dashboard/activity')
      .set('Authorization', `Bearer ${editorToken}`);

    expect(res.status).toBe(200);
    const actors = res.body.map((a) => a.actorName);
    expect(actors).toContain('own-actor');
    expect(actors).not.toContain('foreign-actor');
  });

  it('leaves super_admin unscoped across all three', async () => {
    const stats = await request(app)
      .get('/api/admin/dashboard/stats')
      .set('Authorization', `Bearer ${superToken}`);
    expect(Number(stats.body.totalEvents)).toBe(2);

    const analytics = await request(app)
      .get('/api/admin/dashboard/analytics?days=7')
      .set('Authorization', `Bearer ${superToken}`);
    expect(analytics.body.topGalleries.map((g) => g.slug).sort())
      .toEqual(['foreign-gallery', 'own-gallery']);

    const activity = await request(app)
      .get('/api/admin/dashboard/activity')
      .set('Authorization', `Bearer ${superToken}`);
    expect(activity.body.map((a) => a.actorName)).toContain('foreign-actor');
  });
});

/**
 * Codex round 2: the /activity filter trusts `activity_logs.event_id`, but
 * expenseService was passing `adminId` into logActivity's third positional
 * parameter — which is `eventId`. Admin and event id sequences overlap, so a
 * foreign admin's expense metadata could surface under an editor's event.
 * Those writers now pass the actor instead, leaving event_id NULL.
 */
describe('activity writers do not put admin ids in event_id (GHSA-jhcf)', () => {
  it('expenseService passes the actor, not adminId, as the event id', () => {
    const fs2 = require('fs');
    const src = fs2.readFileSync(
      require('path').join(__dirname, '../../src/services/expenseService.js'), 'utf8',
    );
    // No logActivity call may end with a bare `, adminId)` — that slot is eventId.
    const offenders = src.split('\n').filter(
      (l) => l.includes('logActivity(') && /,\s*adminId\s*\)/.test(l),
    );
    expect(offenders).toEqual([]);
    // And the actor form must actually be in use.
    expect(src).toContain("{ type: 'admin', id: adminId }");
  });
});
