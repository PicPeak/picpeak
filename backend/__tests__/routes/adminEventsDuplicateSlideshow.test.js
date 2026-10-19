/**
 * Duplicating a gallery carries its Live Slideshow style (issue 2189): play
 * order, timing, transition, colour filter and the watermark/QR modes. The
 * category filter follows the clone of its category (or stays on a global
 * one); the share token does not travel, the copy gets its own link. The
 * guest-upload default category is mapped the same way.
 */
process.env.JWT_SECRET = 'duplicate-slideshow-secret-at-least-32-characters';
process.env.NODE_ENV = 'test';

const os = require('os');
const path = require('path');
const fs = require('fs');
const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const { bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken } = require('../integration/helpers/crmDb');

const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplicate-slideshow-'));
process.env.STORAGE_PATH = storageDir;

let db, cleanup, app, adminId, token;

const idOf = (r) => Number(r[0]?.id ?? r[0]);
const auth = (req) => req.set('Authorization', `Bearer ${token}`);
const duplicate = (id) => auth(request(app).post(`/api/admin/events/${id}/duplicate`)).send({
  event_name: `Copy ${Math.random().toString(36).slice(2, 8)}`,
});

async function insertEvent(over = {}) {
  const key = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return idOf(await db('events').insert({
    slug: `dup-show-${key}`,
    event_type: 'wedding', event_name: 'Slideshow source', event_date: '2026-11-20',
    customer_name: 'Anna', customer_email: 'anna@example.com', host_name: 'Anna', host_email: 'anna@example.com',
    admin_email: 'admin@example.com', password_hash: 'x',
    share_link: `/gallery/dup-show-${key}/tok`, share_token: `tok-${key}`,
    expires_at: '2026-12-20T00:00:00.000Z',
    is_active: 1, is_archived: 0, is_draft: 0, created_by: adminId,
    created_at: new Date().toISOString(),
    ...over,
  }).returning('id'));
}

const insertCategory = async (over) => idOf(await db('photo_categories').insert({
  name: 'Ceremony', slug: `ceremony-${Math.random().toString(36).slice(2, 8)}`, ...over,
}).returning('id'));

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  ({ adminId } = await seedMinimal(db));
  await assignAdminRole(db, adminId, 'super_admin');
  token = mintAdminToken(adminId);
  app = express(); app.use(express.json()); app.use(cookieParser());
  app.use('/api/admin/events', require('../../src/routes/adminEvents'));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => { res.status(err.statusCode || err.status || 500).json({ error: err.message, code: err.code }); });
}, 120000);

afterAll(async () => {
  await cleanup();
  fs.rmSync(storageDir, { recursive: true, force: true });
});

describe('POST /:id/duplicate — Live Slideshow style', () => {
  it('copies the style and leaves the share token behind', async () => {
    const source = await insertEvent({
      show_share_token: 'a'.repeat(64),
      show_interval_ms: 9000, show_transition: 'kenburns', show_transition_ms: 1500,
      show_watermark: 1, show_qr: 0, show_colorfilter: 'sepia', show_order: 'random',
    });
    const res = await duplicate(source);
    expect(res.status).toBe(200);

    const copy = await db('events').where({ id: res.body.id }).first();
    expect(copy).toMatchObject({
      show_interval_ms: 9000, show_transition: 'kenburns', show_transition_ms: 1500,
      show_colorfilter: 'sepia', show_order: 'random',
    });
    expect(Boolean(copy.show_watermark)).toBe(true);
    expect(Boolean(copy.show_qr)).toBe(false);
    expect(copy.show_share_token).toBeNull();
  });

  it('keeps inherit (NULL) watermark and QR modes as inherit', async () => {
    const source = await insertEvent({ show_watermark: null, show_qr: null });
    const res = await duplicate(source);
    const copy = await db('events').where({ id: res.body.id }).first();
    expect(copy.show_watermark).toBeNull();
    expect(copy.show_qr).toBeNull();
  });

  it('points the category filter at the clone of an event category', async () => {
    const source = await insertEvent();
    const categoryId = await insertCategory({ event_id: source, is_global: 0 });
    await db('events').where({ id: source }).update({ show_category_id: categoryId });

    const res = await duplicate(source);
    expect(res.status).toBe(200);

    const clone = await db('photo_categories').where({ event_id: res.body.id, name: 'Ceremony' }).first();
    expect(clone).toBeTruthy();
    const copy = await db('events').where({ id: res.body.id }).first();
    expect(Number(copy.show_category_id)).toBe(Number(clone.id));
    expect(Number(copy.show_category_id)).not.toBe(categoryId);
  });

  it('keeps a global category filter as it is', async () => {
    const globalId = await insertCategory({ event_id: null, is_global: 1 });
    const source = await insertEvent({ show_category_id: globalId });
    const res = await duplicate(source);
    const copy = await db('events').where({ id: res.body.id }).first();
    expect(Number(copy.show_category_id)).toBe(globalId);
  });

  it('drops a filter that points at no category the copy can see', async () => {
    const other = await insertEvent();
    const foreignId = await insertCategory({ event_id: other, is_global: 0 });
    const source = await insertEvent({ show_category_id: foreignId });
    const res = await duplicate(source);
    const copy = await db('events').where({ id: res.body.id }).first();
    expect(copy.show_category_id).toBeNull();
  });
});

describe('POST /:id/duplicate — guest-upload default category', () => {
  it('points the upload default at the clone of an event category', async () => {
    const source = await insertEvent();
    const categoryId = await insertCategory({ event_id: source, is_global: 0, name: 'Guests' });
    await db('events').where({ id: source }).update({ upload_category_id: categoryId });

    const res = await duplicate(source);
    expect(res.status).toBe(200);

    const clone = await db('photo_categories').where({ event_id: res.body.id, name: 'Guests' }).first();
    const copy = await db('events').where({ id: res.body.id }).first();
    expect(Number(copy.upload_category_id)).toBe(Number(clone.id));
  });

  it('keeps a global upload default and drops a foreign one', async () => {
    const globalId = await insertCategory({ event_id: null, is_global: 1 });
    const kept = await duplicate(await insertEvent({ upload_category_id: globalId }));
    expect(Number((await db('events').where({ id: kept.body.id }).first()).upload_category_id)).toBe(globalId);

    const foreignId = await insertCategory({ event_id: await insertEvent(), is_global: 0 });
    const dropped = await duplicate(await insertEvent({ upload_category_id: foreignId }));
    expect((await db('events').where({ id: dropped.body.id }).first()).upload_category_id).toBeNull();
  });
});
