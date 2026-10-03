/**
 * Permanent archive delete clears every row the event owns before the events
 * row goes (issue 1733). activity_logs, access_logs and email_queue reference
 * events without ON DELETE CASCADE, so on PostgreSQL the events delete failed
 * on the foreign key; SQLite never enforces the keys, which is why the
 * explicit deletes are what this test can observe.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const express = require('express');
const request = require('supertest');

describe('DELETE /admin/archives/:id', () => {
  let tmpDir; let db; let cleanup; let app;

  beforeAll(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'picpeak-archive-delete-'));
    process.env.NODE_ENV = 'test';
    process.env.TEST_DATABASE_PATH = path.join(tmpDir, 'data', 'test.db');
    process.env.STORAGE_PATH = path.join(tmpDir, 'storage');
    await fs.promises.mkdir(path.dirname(process.env.TEST_DATABASE_PATH), { recursive: true });

    jest.resetModules();
    jest.doMock('../../src/middleware/auth', () => ({
      adminAuth: (req, _res, next) => { req.admin = { id: 1, username: 'tester' }; next(); },
    }));
    jest.doMock('../../src/middleware/permissions', () => ({
      requirePermission: () => (_req, _res, next) => next(),
    }));
    jest.doMock('../../src/middleware/ownership', () => ({
      requireEventOwnership: (_req, _res, next) => next(),
    }));

    ({ db, cleanup } = await require('./helpers/crmDb').bootCrmDb());
    await fs.promises.mkdir(path.join(process.env.STORAGE_PATH, 'archives'), { recursive: true });

    app = express();
    app.use(express.json());
    app.use('/admin/archives', require('../../src/routes/adminArchives'));
  }, 180000);

  afterAll(async () => {
    if (cleanup) await cleanup();
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it('removes the event and every child row that references it', async () => {
    const [ev] = await db('events').insert({
      slug: 'perm-delete', event_type: 'other', event_name: 'Perm Delete', event_date: '2026-01-01',
      host_email: 'h@example.com', admin_email: 'a@example.com', password_hash: 'x',
      share_link: '/gallery/perm-delete/tok', share_token: 'perm-delete-tok',
      is_active: 0, is_archived: 1, is_draft: 0, archive_path: 'archives/perm-delete.zip',
      created_at: new Date().toISOString(),
    }).returning('id');
    const eventId = typeof ev === 'object' ? ev.id : ev;
    const now = new Date().toISOString();
    await db('photos').insert({ event_id: eventId, filename: 'a.jpg', path: 'events/perm/a.jpg', type: 'individual', uploaded_at: now });
    await db('activity_logs').insert({ event_id: eventId, activity_type: 'event_created', actor_type: 'admin', actor_id: 1, created_at: now });
    await db('access_logs').insert({ event_id: eventId, action: 'view', ip_address: '127.0.0.1', timestamp: now });
    await db('email_queue').insert({ event_id: eventId, recipient_email: 'h@example.com', email_type: 'gallery_created', email_data: '{}', status: 'pending', created_at: now });

    const res = await request(app).delete(`/admin/archives/${eventId}`);
    expect(res.status).toBe(200);

    for (const table of ['photos', 'activity_logs', 'access_logs', 'email_queue']) {
      const [{ n }] = await db(table).where('event_id', eventId).count('* as n');
      expect({ table, n: Number(n) }).toEqual({ table, n: 0 });
    }
    expect(await db('events').where('id', eventId).first()).toBeUndefined();
    // The route's own audit row is written after the delete and has no event FK.
    const [{ audits }] = await db('activity_logs').where('activity_type', 'archive_deleted').count('* as audits');
    expect(Number(audits)).toBe(1);
  });
});
