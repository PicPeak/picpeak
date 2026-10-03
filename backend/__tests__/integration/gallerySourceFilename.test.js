/**
 * The guest photo list carries `source_filename` next to `original_filename`
 * (issue 1733, A3d): the camera name written once at ingest, which survives a
 * replace (migration 193) while original_filename does not. Null when nothing
 * was recorded.
 */
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'source-filename-secret-at-least-32-characters';

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

const SLUG = 'source-filename-gallery';
let db; let cleanup; let app; let eventId;

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  await seedMinimal(db);
  const [ev] = await db('events').insert({
    slug: SLUG, event_type: 'wedding', event_name: 'Source Filename', event_date: '2026-08-01',
    host_email: 'h@example.com', admin_email: 'a@example.com', password_hash: 'x',
    share_link: `/gallery/${SLUG}/share`, share_token: 'source-filename-share',
    expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
    is_active: 1, is_archived: 0, is_draft: 0, created_at: new Date().toISOString(),
  }).returning('id');
  eventId = typeof ev === 'object' ? ev.id : ev;
  await db('photos').insert([
    { event_id: eventId, filename: 'render.jpg', path: 'events/sf/render.jpg', type: 'individual',
      original_filename: 'render-edit.jpg', source_filename: 'DSC_0001.NEF', uploaded_at: new Date().toISOString() },
    { event_id: eventId, filename: 'legacy.jpg', path: 'events/sf/legacy.jpg', type: 'individual',
      uploaded_at: new Date().toISOString() },
  ]);
  app = express(); app.use(express.json()); app.use(cookieParser());
  app.use('/api/gallery', require('../../src/routes/gallery'));
}, 180000);

afterAll(async () => { if (cleanup) await cleanup(); });

test('source_filename rides on the guest photo list, null when unrecorded', async () => {
  const token = jwt.sign({ eventId, eventSlug: SLUG, type: 'gallery' }, process.env.JWT_SECRET,
    { expiresIn: '1h', issuer: 'picpeak-auth' });
  const res = await request(app).get(`/api/gallery/${SLUG}/photos`).set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  const photos = Array.isArray(res.body) ? res.body : res.body.photos;
  const byName = Object.fromEntries(photos.map((p) => [p.filename, p]));
  expect(byName['render.jpg']).toMatchObject({ original_filename: 'render-edit.jpg', source_filename: 'DSC_0001.NEF' });
  expect(byName['legacy.jpg']).toMatchObject({ original_filename: null, source_filename: null });
});
