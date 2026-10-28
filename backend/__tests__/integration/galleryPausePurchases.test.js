const request = require('supertest');
const express = require('express');
const crypto = require('crypto');
const { bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken } = require('./helpers/crmDb');

process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
const HOUR = 3600e3;
const iso = (time) => new Date(time).toISOString();
const base = Date.parse('2030-01-01T12:00:00Z');
let db, cleanup, app, adminId, clock, event, photoId;
let counter = 0;

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  ({ adminId } = await seedMinimal(db));
  await assignAdminRole(db, adminId);
  app = express(); app.use(express.json());
  app.use('/api/admin/events', require('../../src/routes/adminEvents'));
  app.use('/api/gallery', require('../../src/routes/gallery'));
});
beforeEach(async () => {
  clock = jest.spyOn(Date, 'now').mockReturnValue(base);
  const slug = `pause-purchases-${++counter}`;
  const [created] = await db('events').insert({ slug, event_name: 'Purchase clock', event_type: 'wedding',
    event_date: '2030-01-01', host_email: 'host@example.test', password_hash: 'unused', share_link: `/gallery/${slug}`,
    created_by: adminId, is_active: true, is_draft: false, is_archived: false, is_priced: true,
    expires_at: iso(base + 10 * 24 * HOUR),
  }).returning('id');
  event = await db('events').where({ id: created.id ?? created }).first();
  const key = `events/active/${slug}/photo.jpg`;
  await require('../../src/services/storage').getStorage().put(key, Buffer.from('original-photo'));
  const [photo] = await db('photos').insert({ event_id: event.id, filename: 'photo.jpg', path: key,
    type: 'individual', media_type: 'image', mime_type: 'image/jpeg', visibility: 'visible', processing_status: 'complete',
  }).returning('id');
  photoId = photo.id ?? photo;
});
afterEach(() => clock.mockRestore());
afterAll(async () => { if (cleanup) await cleanup(); });

const save = (paused, extra = {}) => request(app).put(`/api/admin/events/${event.id}`)
  .set('Authorization', `Bearer ${mintAdminToken(adminId)}`).send({ temporarily_disabled: paused, ...extra });
async function purchase(bought, end, status = 'completed') {
  const orderId = crypto.randomUUID(), accessToken = crypto.randomBytes(24).toString('hex');
  await db('photo_purchase_orders').insert({ order_id: orderId, gallery_id: event.id, buyer_email: 'buyer@example.test',
    total_cents: 100, status, purchased_at: iso(bought), expires_at: iso(end), access_token: accessToken });
  await db('photo_purchases').insert({ order_id: orderId, gallery_id: event.id, photo_id: photoId,
    buyer_email: 'buyer@example.test', purchased_at: iso(bought), expires_at: iso(end), access_token: accessToken });
  return { orderId, accessToken, originalEnd: iso(end) };
}
const expiry = async (item) => (await db('photo_purchase_orders').where({ order_id: item.orderId }).first()).expires_at;
const page = (item) => request(app).get(`/api/gallery/purchased-downloads/${item.accessToken}`);

it('freezes active purchases, credits only each purchase overlap once, and preserves expired/refunded purchases', async () => {
  const earlier = await purchase(base - 24 * HOUR, base + HOUR);
  const expired = await purchase(base - 24 * HOUR, base - HOUR);
  const refunded = await purchase(base - 24 * HOUR, base + HOUR, 'refunded');
  await save(true, { temporarily_disabled_at: '1900-01-01T00:00:00Z' }).expect(200);
  expect((await db('events').where({ id: event.id }).first()).temporarily_disabled_at).toBe(iso(base));
  clock.mockReturnValue(base + HOUR);
  await save(true).expect(200);
  expect((await db('events').where({ id: event.id }).first()).temporarily_disabled_at).toBe(iso(base));
  const during = await purchase(base + 2 * HOUR, base + 3 * HOUR);
  clock.mockReturnValue(base + 5 * HOUR);
  expect((await page(earlier).expect(200)).body).toMatchObject({ temporarily_disabled: true, photos: [] });
  await page(during).expect(200);
  await page(expired).expect(403); await page(refunded).expect(403);
  const summary = await request(app).get(`/api/admin/events/${event.id}/photo-orders`)
    .set('Authorization', `Bearer ${mintAdminToken(adminId)}`).expect(200);
  expect(summary.body.orders.find((order) => order.order_id === earlier.orderId)).toMatchObject({
    expires_at: iso(base + 6 * HOUR), remaining_ms: HOUR, remaining_days: 1,
  });

  const saves = await Promise.all([save(false), save(false)]);
  expect(saves.map((response) => response.status)).toEqual([200, 200]);
  expect(await expiry(earlier)).toBe(iso(base + 6 * HOUR));
  expect(await expiry(during)).toBe(iso(base + 6 * HOUR));
  expect(await expiry(expired)).toBe(expired.originalEnd);
  expect(await expiry(refunded)).toBe(refunded.originalEnd);
  const photoRows = await db('photo_purchases').whereIn('order_id', [earlier.orderId, during.orderId]);
  expect(photoRows.map((row) => row.expires_at)).toEqual([iso(base + 6 * HOUR), iso(base + 6 * HOUR)]);
  const restored = await page(earlier).expect(200);
  expect(restored.body.expires_at).toBe(iso(base + 6 * HOUR));
  await request(app).get(restored.body.photos[0].photo_url).expect(200);
  expect((await db('events').where({ id: event.id }).first()).temporarily_disabled_at).toBeNull();

  // A later pause credits only its own interval; an already-expired window stays expired.
  clock.mockReturnValue(base + 5.5 * HOUR); await save(true).expect(200);
  clock.mockReturnValue(base + 8.5 * HOUR); await save(false).expect(200);
  expect(await expiry(earlier)).toBe(iso(base + 9 * HOUR));
  clock.mockReturnValue(base + 12 * HOUR); await save(true).expect(200);
  clock.mockReturnValue(base + 14 * HOUR); await save(false).expect(200);
  expect(await expiry(earlier)).toBe(iso(base + 9 * HOUR));
});

it('caps effective access at unchanged gallery expiry without discarding earned time', async () => {
  await db('events').where({ id: event.id }).update({ expires_at: iso(base + 6 * HOUR) });
  const item = await purchase(base - HOUR, base + 3 * HOUR);
  await save(true).expect(200);
  clock.mockReturnValue(base + 5 * HOUR); await save(false).expect(200);
  expect(await expiry(item)).toBe(iso(base + 8 * HOUR));
  expect((await page(item).expect(200)).body.expires_at).toBe(iso(base + 6 * HOUR));
  expect(new Date((await db('events').where({ id: event.id }).first()).expires_at).toISOString()).toBe(iso(base + 6 * HOUR));
  clock.mockReturnValue(base + 7 * HOUR); await page(item).expect(403);
  await request(app).get(`/api/gallery/purchased-downloads/${item.accessToken}/photos/${photoId}`).expect(403);
});

it('keeps earned time when a resume also shortens gallery expiry, and applies the cutoff to pages, files and admin summaries', async () => {
  const item = await purchase(base - HOUR, base + 3 * HOUR);
  await save(true).expect(200);
  clock.mockReturnValue(base + 5 * HOUR);
  await save(false, { expires_at: iso(base + 6 * HOUR) }).expect(200);
  expect(await expiry(item)).toBe(iso(base + 8 * HOUR));
  expect((await db('photo_purchases').where({ order_id: item.orderId }).first()).expires_at).toBe(iso(base + 8 * HOUR));
  expect((await page(item).expect(200)).body.expires_at).toBe(iso(base + 6 * HOUR));
  const summary = await request(app).get(`/api/admin/events/${event.id}/photo-orders`)
    .set('Authorization', `Bearer ${mintAdminToken(adminId)}`).expect(200);
  expect(summary.body.orders.find((order) => order.order_id === item.orderId)).toMatchObject({
    expires_at: iso(base + 6 * HOUR), remaining_ms: HOUR,
  });
  clock.mockReturnValue(base + 7 * HOUR);
  await page(item).expect(403);
  await request(app).get(`/api/gallery/purchased-downloads/${item.accessToken}/photos/${photoId}`).expect(403);
  // Restoring a gallery cutoff cannot recover time that was overwritten.
  // The earned purchase window is intact and is still its own upper limit.
  await save(false, { expires_at: iso(base + 10 * HOUR) }).expect(200);
  const restored = await page(item).expect(200);
  expect(restored.body.expires_at).toBe(iso(base + 8 * HOUR));
  await request(app).get(restored.body.photos[0].photo_url).expect(200);
  clock.mockReturnValue(base + 9 * HOUR); await page(item).expect(403);
});

it('does not compensate when a guarded event update loses its race', async () => {
  const item = await purchase(base - HOUR, base + HOUR);
  await save(true).expect(200);
  clock.mockReturnValue(base + 3 * HOUR);
  const { updateGalleryAvailability } = require('../../src/services/galleryPauseService');
  expect(await updateGalleryAvailability(event.id, { temporarily_disabled: false }, (trx, patch) =>
    trx('events').where({ id: event.id, password_hash: 'a-different-credential' }).update(patch))).toBe(0);
  expect(await expiry(item)).toBe(item.originalEnd);
  expect((await db('events').where({ id: event.id }).first()).temporarily_disabled).toBeTruthy();
});
