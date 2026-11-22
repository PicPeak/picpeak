/**
 * First-visit walkthrough switch (issue 2551).
 *
 *  - migration 372 adds events.walkthrough_enabled, off by default, and is
 *    idempotent and reversible
 *  - a new event takes the Settings > Events default when the request omits
 *    the flag; an explicit value wins
 *  - the default round-trips through PUT /admin/settings/general as a boolean
 *  - the event update validates and stores the flag; a duplicate copies it
 *  - the public gallery payload carries it
 */
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'walkthrough-secret-at-least-32-characters';

const os = require('os');
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken } = require('./helpers/crmDb');

const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walkthrough-'));
process.env.STORAGE_PATH = storageDir;

jest.setTimeout(120000);

describe('gallery walkthrough switch (issue 2551)', () => {
  let db; let cleanup; let app; let adminId; let adminToken; let counter = 0;

  const admin = (req) => req.set('Authorization', `Bearer ${adminToken}`);
  const idOf = (r) => Number(r[0]?.id ?? r[0]);

  async function makeEvent(overrides = {}) {
    counter += 1;
    const slug = `walkthrough-${counter}`;
    const id = idOf(await db('events').insert({
      slug, event_type: 'wedding', event_name: `Walkthrough ${counter}`, event_date: '2026-08-01',
      host_email: 'h@example.com', admin_email: 'a@example.com', password_hash: 'x',
      share_link: `/gallery/${slug}/share`, share_token: `walkthrough-share-${counter}`,
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      is_active: 1, is_archived: 0, is_draft: 0, created_by: adminId, created_at: new Date().toISOString(),
      ...overrides,
    }).returning('id'));
    const token = jwt.sign({ eventId: id, eventSlug: slug, type: 'gallery' }, process.env.JWT_SECRET,
      { expiresIn: '1h', issuer: 'picpeak-auth' });
    return { id, slug, token };
  }

  const guestPayload = async ({ slug, token }) => {
    const res = await request(app).get(`/api/gallery/${slug}/photos`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    return res.body;
  };

  const flagOf = async (id) => Boolean((await db('events').where({ id }).first()).walkthrough_enabled);

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
    app.use('/api/admin/settings', require('../../src/routes/adminSettings'));
  }, 180000);

  afterAll(async () => {
    if (cleanup) await cleanup();
    fs.rmSync(storageDir, { recursive: true, force: true });
  });

  it('is off for an existing gallery, and the guest payload says so', async () => {
    const event = await makeEvent();
    expect(await flagOf(event.id)).toBe(false);
    expect((await guestPayload(event)).event.walkthrough_enabled).toBe(false);
  });

  it('validates and stores the switch, and the payload follows it', async () => {
    const event = await makeEvent();
    const bad = await admin(request(app).put(`/api/admin/events/${event.id}`)).send({ walkthrough_enabled: 'maybe' });
    expect(bad.status).toBe(400);
    await admin(request(app).put(`/api/admin/events/${event.id}`)).send({ walkthrough_enabled: true }).expect(200);
    expect(await flagOf(event.id)).toBe(true);
    expect((await guestPayload(event)).event.walkthrough_enabled).toBe(true);
    await admin(request(app).put(`/api/admin/events/${event.id}`)).send({ walkthrough_enabled: false }).expect(200);
    expect(await flagOf(event.id)).toBe(false);
  });

  it('round-trips the Settings > Events default as a boolean', async () => {
    await admin(request(app).put('/api/admin/settings/general'))
      .send({ event_default_walkthrough_enabled: 'true' }).expect(200);
    let got = (await admin(request(app).get('/api/admin/settings')).expect(200)).body;
    expect(got.event_default_walkthrough_enabled).toBe(true);
    await admin(request(app).put('/api/admin/settings/general'))
      .send({ event_default_walkthrough_enabled: false }).expect(200);
    got = (await admin(request(app).get('/api/admin/settings')).expect(200)).body;
    expect(got.event_default_walkthrough_enabled).toBe(false);
  });

  it('a new event takes the default when the request omits the flag', async () => {
    const { createEvent } = require('../../src/services/eventCreationService');
    const actor = { id: adminId };
    const base = {
      event_type: 'wedding', event_date: '2026-09-01', customer_name: 'C', customer_email: 'c@example.com',
      admin_email: 'a@example.com', require_password: false, expiration_days: 30,
    };
    await db('app_settings').where({ setting_key: 'event_default_walkthrough_enabled' }).del();
    const unset = await createEvent({ ...base, event_name: 'Walkthrough unset' }, { actor });
    expect(await flagOf(unset.id)).toBe(false);

    await db('app_settings').insert({
      setting_key: 'event_default_walkthrough_enabled', setting_value: JSON.stringify(true), setting_type: 'general',
      updated_at: new Date().toISOString(),
    });
    try {
      const defaulted = await createEvent({ ...base, event_name: 'Walkthrough default' }, { actor });
      const explicit = await createEvent({ ...base, event_name: 'Walkthrough explicit', walkthrough_enabled: false }, { actor });
      expect(await flagOf(defaulted.id)).toBe(true);
      expect(await flagOf(explicit.id)).toBe(false);
    } finally {
      await db('app_settings').where({ setting_key: 'event_default_walkthrough_enabled' }).del();
    }
  });

  it('duplicating an event copies the switch', async () => {
    const on = await makeEvent({ walkthrough_enabled: true });
    const off = await makeEvent();
    const copyOn = await admin(request(app).post(`/api/admin/events/${on.id}/duplicate`)).send({ event_name: 'Copy on' });
    expect(copyOn.status).toBe(200);
    expect(await flagOf(Number(copyOn.body.id))).toBe(true);
    const copyOff = await admin(request(app).post(`/api/admin/events/${off.id}/duplicate`)).send({ event_name: 'Copy off' });
    expect(copyOff.status).toBe(200);
    expect(await flagOf(Number(copyOff.body.id))).toBe(false);
  });

  it('migration 372 is idempotent and reversible', async () => {
    const migration = require('../../migrations/core/372_event_walkthrough');
    await migration.up(db);
    await migration.down(db);
    expect(await db.schema.hasColumn('events', 'walkthrough_enabled')).toBe(false);
    await migration.down(db);
    await migration.up(db);
    await migration.up(db);
    expect(await db.schema.hasColumn('events', 'walkthrough_enabled')).toBe(true);
    const event = await makeEvent();
    expect(await flagOf(event.id)).toBe(false);
  });
});
