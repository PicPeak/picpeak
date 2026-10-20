/**
 * Neutral photo labels (issue 1733, E6).
 *
 *  - migration 314 adds events.neutral_photo_labels, off by default
 *  - the guest event payload carries the switch, and the photo list keeps
 *    `filename` either way (downloads are still named by it)
 *  - the event update validates and stores it; a duplicate copies it
 */
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'neutral-labels-secret-at-least-32-characters';

const os = require('os');
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken } = require('./helpers/crmDb');

const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neutral-labels-'));
process.env.STORAGE_PATH = storageDir;

describe('neutral photo labels (issue 1733, E6)', () => {
  let db; let cleanup; let app; let adminId; let adminToken; let counter = 0;

  const admin = (req) => req.set('Authorization', `Bearer ${adminToken}`);
  const idOf = (r) => Number(r[0]?.id ?? r[0]);

  async function makeEvent(overrides = {}) {
    counter += 1;
    const slug = `neutral-test-${counter}`;
    const id = idOf(await db('events').insert({
      slug, event_type: 'wedding', event_name: `Neutral Test ${counter}`, event_date: '2026-08-01',
      host_email: 'h@example.com', admin_email: 'a@example.com', password_hash: 'x',
      share_link: `/gallery/${slug}/share`, share_token: `neutral-share-${counter}`,
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      is_active: 1, is_archived: 0, is_draft: 0, created_by: adminId, created_at: new Date().toISOString(),
      ...overrides,
    }).returning('id'));
    await db('photos').insert({
      event_id: id, filename: 'IMG_4711.jpg', original_filename: 'IMG_4711.jpg', path: `${slug}/IMG_4711.jpg`,
      type: 'individual', media_type: 'image', mime_type: 'image/jpeg', uploaded_at: new Date().toISOString(),
    });
    const token = jwt.sign({ eventId: id, eventSlug: slug, type: 'gallery' }, process.env.JWT_SECRET,
      { expiresIn: '1h', issuer: 'picpeak-auth' });
    return { id, slug, token };
  }

  const guestPayload = async ({ slug, token }) => {
    const res = await request(app).get(`/api/gallery/${slug}/photos`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    return res.body;
  };

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    ({ adminId } = await seedMinimal(db));
    await assignAdminRole(db, adminId, 'super_admin');
    adminToken = mintAdminToken(adminId);
    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/gallery', require('../../src/routes/gallery'));
    app.use('/api/admin/events', require('../../src/routes/adminEvents'));
  }, 180000);

  afterAll(async () => {
    if (cleanup) await cleanup();
    fs.rmSync(storageDir, { recursive: true, force: true });
  });

  it('is off for an existing gallery, and the guest payload says so', async () => {
    const event = await makeEvent();
    expect(Boolean((await db('events').where({ id: event.id }).first()).neutral_photo_labels)).toBe(false);
    const body = await guestPayload(event);
    expect(body.event.neutral_photo_labels).toBe(false);
    expect(body.photos[0].filename).toBe('IMG_4711.jpg');
  });

  it('sends the switch to guests and keeps the filename for downloads', async () => {
    const event = await makeEvent({ neutral_photo_labels: 1 });
    const body = await guestPayload(event);
    expect(body.event.neutral_photo_labels).toBe(true);
    expect(body.photos[0].filename).toBe('IMG_4711.jpg');
  });

  it('is validated and stored through the event update', async () => {
    const event = await makeEvent();
    const bad = await admin(request(app).put(`/api/admin/events/${event.id}`)).send({ neutral_photo_labels: 'sometimes' });
    expect(bad.status).toBe(400);
    const ok = await admin(request(app).put(`/api/admin/events/${event.id}`)).send({ neutral_photo_labels: true });
    expect(ok.status).toBe(200);
    expect(Boolean((await db('events').where({ id: event.id }).first()).neutral_photo_labels)).toBe(true);
    expect((await guestPayload(event)).event.neutral_photo_labels).toBe(true);
    const off = await admin(request(app).put(`/api/admin/events/${event.id}`)).send({ neutral_photo_labels: false });
    expect(off.status).toBe(200);
    expect((await guestPayload(event)).event.neutral_photo_labels).toBe(false);
  });

  it('travels with a duplicated gallery', async () => {
    const event = await makeEvent({ neutral_photo_labels: 1 });
    const res = await admin(request(app).post(`/api/admin/events/${event.id}/duplicate`)).send({ event_name: 'Neutral copy' });
    expect(res.status).toBe(200);
    expect(Boolean((await db('events').where({ id: res.body.id }).first()).neutral_photo_labels)).toBe(true);
  });

  it('migration 314 is idempotent and reversible', async () => {
    const migration = require('../../migrations/core/314_event_neutral_photo_labels');
    await migration.up(db);
    expect(await db.schema.hasColumn('events', 'neutral_photo_labels')).toBe(true);
    await migration.down(db);
    expect(await db.schema.hasColumn('events', 'neutral_photo_labels')).toBe(false);
    await migration.down(db);
    await migration.up(db);
    expect(await db.schema.hasColumn('events', 'neutral_photo_labels')).toBe(true);
  });
});
