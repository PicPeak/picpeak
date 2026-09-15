/**
 * Which events, archives and gallery links each role sees, and which
 * per-event records it may change.
 *
 * The events list and detail only narrowed results for the `editor` role, so
 * viewer, team_photographer and custom roles listed every owner's events, and
 * every role below super_admin received each gallery's share token, client
 * token and slideshow token. The archive list, the dashboard, upload status
 * and per-event category writes had the same gap.
 *
 * Now: super_admin and the built-in admin role see every event, but the links
 * of an event the admin cannot act on are withheld. Every other role sees its
 * own events plus ownerless ones, the rule requireEventOwnership applies.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-evscope-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'evscope-test-secret';
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-evscope-storage-'));

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const { bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken } = require('../integration/helpers/crmDb');

const LINK_COLUMNS = ['share_token', 'share_link', 'client_share_token', 'show_share_token'];

describe('event visibility and gallery links by role', () => {
  let db; let cleanup; let app;
  const tok = {};
  const id = {};

  const as = (req, who) => req.set('Authorization', `Bearer ${tok[who]}`);
  const now = () => new Date().toISOString();

  async function mkAdmin(name, roleName) {
    const rows = await db('admin_users').insert({
      username: `evscope-${name}`,
      email: `evscope-${name}@example.com`,
      password_hash: 'x',
      must_change_password: false,
      created_at: now(),
    }).returning('id');
    const adminId = rows[0]?.id ?? rows[0];
    await assignAdminRole(db, adminId, roleName);
    tok[name] = mintAdminToken(adminId);
    return adminId;
  }

  async function mkEvent(slug, createdBy, over = {}) {
    const rows = await db('events').insert({
      slug,
      event_type: 'wedding',
      event_name: slug,
      event_date: '2026-08-01',
      host_email: 'h@example.com',
      admin_email: 'a@example.com',
      password_hash: 'x',
      share_token: `st-${slug}`,
      share_link: `/gallery/${slug}/st-${slug}`,
      client_share_token: `ct-${slug}`,
      show_share_token: `sh-${slug}`,
      created_by: createdBy,
      expires_at: new Date(Date.now() + 30 * 864e5).toISOString(),
      is_active: 1,
      is_archived: 0,
      is_draft: 0,
      created_at: now(),
      ...over,
    }).returning('id');
    return rows[0]?.id ?? rows[0];
  }

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    const { adminId: superId } = await seedMinimal(db);
    await assignAdminRole(db, superId, 'super_admin');
    tok.super = mintAdminToken(superId);

    id.editor = await mkAdmin('editor', 'editor');
    id.admin = await mkAdmin('admin', 'admin');
    id.viewer = await mkAdmin('viewer', 'viewer');
    id.team = await mkAdmin('team', 'team_photographer');
    id.solo = await mkAdmin('solo', 'solo_photographer');

    id.editorEvent = await mkEvent('ed-gallery', id.editor);
    id.ownerlessEvent = await mkEvent('shared-gallery', null);
    id.adminEvent = await mkEvent('ad-gallery', id.admin);
    id.editorArchive = await mkEvent('ed-archive', id.editor, { is_archived: 1, archived_at: now() });
    id.adminArchive = await mkEvent('ad-archive', id.admin, { is_archived: 1, archived_at: now() });

    for (const [eventId, name] of [[id.editorEvent, 'ed'], [id.adminEvent, 'ad']]) {
      await db('photos').insert({
        event_id: eventId,
        filename: `${name}.jpg`,
        path: `events/active/${name}.jpg`,
        type: 'individual',
        size_bytes: 1000,
        uploaded_at: now(),
        upload_id: `up-${name}`,
        processing_status: 'complete',
      });
    }

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/admin/events', require('../../src/routes/adminEvents'));
    app.use('/api/admin/archives', require('../../src/routes/adminArchives'));
    app.use('/api/admin/categories', require('../../src/routes/adminCategories'));
    app.use('/api/admin/photos', require('../../src/routes/adminPhotos'));
    app.use('/api/admin/dashboard', require('../../src/routes/adminDashboard'));
    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => {
      res.status(err.statusCode || err.status || 500).json({ error: err.message });
    });
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  const listEvents = async (who) => {
    const res = await as(request(app).get('/api/admin/events').query({ limit: 100 }), who);
    expect(res.status).toBe(200);
    return new Map(res.body.events.map((event) => [event.id, event]));
  };

  describe('events list and detail', () => {
    it('shows the admin role every event, without the links of events it cannot act on', async () => {
      const events = await listEvents('admin');

      expect([...events.keys()]).toEqual(expect.arrayContaining([id.editorEvent, id.ownerlessEvent, id.adminEvent]));
      const foreign = events.get(id.editorEvent);
      for (const column of LINK_COLUMNS) expect(foreign).not.toHaveProperty(column);
      expect(foreign.share_secrets_hidden).toBe(true);
      expect(foreign.event_name).toBe('ed-gallery');

      expect(events.get(id.adminEvent).share_token).toBe('st-ad-gallery');
      expect(events.get(id.ownerlessEvent).client_share_token).toBe('ct-shared-gallery');
      expect(events.get(id.adminEvent).share_secrets_hidden).toBeUndefined();
    });

    it('lets the admin role read another owner\'s event, still without its links', async () => {
      const res = await as(request(app).get(`/api/admin/events/${id.editorEvent}`), 'admin');

      expect(res.status).toBe(200);
      for (const column of LINK_COLUMNS) expect(res.body).not.toHaveProperty(column);
      expect(res.body.share_secrets_hidden).toBe(true);
    });

    it('limits the viewer role to ownerless events and 404s another owner\'s event', async () => {
      const events = await listEvents('viewer');

      expect(events.has(id.ownerlessEvent)).toBe(true);
      expect(events.has(id.editorEvent)).toBe(false);
      expect(events.has(id.adminEvent)).toBe(false);
      expect(events.get(id.ownerlessEvent).share_token).toBe('st-shared-gallery');

      const res = await as(request(app).get(`/api/admin/events/${id.editorEvent}`), 'viewer');
      expect(res.status).toBe(404);
    });

    it('lists the editor\'s own and ownerless events, with their links', async () => {
      const events = await listEvents('editor');

      expect(events.has(id.editorEvent)).toBe(true);
      expect(events.has(id.ownerlessEvent)).toBe(true);
      expect(events.has(id.adminEvent)).toBe(false);
      expect(events.get(id.editorEvent).share_link).toBe('/gallery/ed-gallery/st-ed-gallery');
    });

    it('shows super_admin every event with its links', async () => {
      const events = await listEvents('super');

      for (const eventId of [id.editorEvent, id.ownerlessEvent, id.adminEvent]) {
        expect(events.get(eventId).share_token).toBeTruthy();
        expect(events.get(eventId).share_secrets_hidden).toBeUndefined();
      }
    });
  });

  it('scopes the archive list and its totals like the events list', async () => {
    const viewer = await as(request(app).get('/api/admin/archives'), 'viewer');
    expect(viewer.status).toBe(200);
    expect(viewer.body.archives.map((a) => a.id)).not.toEqual(expect.arrayContaining([id.editorArchive]));
    expect(viewer.body.archives.map((a) => a.id)).not.toEqual(expect.arrayContaining([id.adminArchive]));
    expect(viewer.body.totals.archives).toBe(0);

    const admin = await as(request(app).get('/api/admin/archives'), 'admin');
    expect(admin.status).toBe(200);
    expect(admin.body.archives.map((a) => a.id)).toEqual(expect.arrayContaining([id.editorArchive, id.adminArchive]));
    expect(admin.body.totals.archives).toBe(2);
  });

  describe('per-event categories', () => {
    let foreignCategoryId;

    beforeAll(async () => {
      const rows = await db('photo_categories').insert({
        name: 'Ceremony', slug: 'ceremony', is_global: false, event_id: id.editorEvent, display_order: 1,
      }).returning('id');
      foreignCategoryId = rows[0]?.id ?? rows[0];
    });

    it('refuses to create, rename, re-hero or delete a category on another owner\'s event', async () => {
      const created = await as(request(app).post('/api/admin/categories'), 'solo')
        .send({ name: 'Party', is_global: false, event_id: id.editorEvent });
      expect(created.status).toBe(403);
      expect(await db('photo_categories').where({ event_id: id.editorEvent, slug: 'party' })).toHaveLength(0);

      const renamed = await as(request(app).put(`/api/admin/categories/${foreignCategoryId}`), 'solo')
        .send({ name: 'Renamed', allow_downloads: true });
      expect(renamed.status).toBe(403);

      const hero = await as(request(app).put(`/api/admin/categories/${foreignCategoryId}/hero`), 'solo')
        .send({ hero_photo_id: null });
      expect(hero.status).toBe(403);

      const deleted = await as(request(app).delete(`/api/admin/categories/${foreignCategoryId}`), 'solo');
      expect(deleted.status).toBe(403);

      const row = await db('photo_categories').where({ id: foreignCategoryId }).first();
      expect(row.name).toBe('Ceremony');
    });

    it('still allows categories on an ownerless event and global categories', async () => {
      const perEvent = await as(request(app).post('/api/admin/categories'), 'solo')
        .send({ name: 'Shared Party', is_global: false, event_id: id.ownerlessEvent });
      expect(perEvent.status).toBe(200);

      const global = await as(request(app).post('/api/admin/categories'), 'solo')
        .send({ name: 'Evscope Global', is_global: true });
      expect(global.status).toBe(200);
    });
  });

  it('hides another owner\'s upload status from a role limited to its own events', async () => {
    const foreign = await as(request(app).get('/api/admin/photos/uploads/up-ed/status'), 'team');
    expect(foreign.status).toBe(404);

    const own = await as(request(app).get('/api/admin/photos/uploads/up-ed/status'), 'editor');
    expect(own.status).toBe(200);
    expect(own.body.photos[0].filename).toBe('ed.jpg');
  });

  it('scopes the dashboard totals for roles other than super_admin and admin', async () => {
    const viewer = await as(request(app).get('/api/admin/dashboard/stats'), 'viewer');
    expect(viewer.status).toBe(200);
    expect(Number(viewer.body.totalPhotos)).toBe(0);

    const admin = await as(request(app).get('/api/admin/dashboard/stats'), 'admin');
    expect(admin.status).toBe(200);
    expect(Number(admin.body.totalPhotos)).toBe(2);
  });
});
