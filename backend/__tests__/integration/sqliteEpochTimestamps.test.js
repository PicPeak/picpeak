/**
 * SQLite epoch-timestamp normalization (#485 follow-up).
 *
 * On SQLite, timestamp columns written with a raw `new Date()` through knex
 * hold epoch-millisecond numbers. Postgres returns ISO strings, so frontend
 * code written against Postgres calls parseISO() and crashes on native
 * (SQLite) installs — the exact class fixed for admin Users in #485, which
 * listed api tokens / photos / activity as an out-of-scope follow-up.
 *
 * Pins:
 *  - gallery /photos serializes uploaded_at / captured_at as ISO strings
 *    even when the row holds an epoch number (pre-fix archive restores)
 *  - the api-tokens list serializes created_at / expires_at / last_used_at /
 *    revoked_at as ISO strings for epoch-stored rows
 */

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'epoch-test-secret';

const SLUG = 'epoch-test-event';
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

describe('SQLite epoch timestamp normalization', () => {
  let db;
  let cleanup;
  let app;
  let eventId;
  let adminToken;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);

    const inserted = await db('events').insert({
      slug: SLUG,
      event_type: 'wedding',
      event_name: 'Epoch Test',
      event_date: '2026-08-01',
      host_email: 'host@example.com',
      admin_email: 'admin@example.com',
      password_hash: 'x',
      share_link: `/gallery/${SLUG}/share`,
      share_token: 'epoch-test-share',
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      is_active: 1,
      is_archived: 0,
      is_draft: 0,
      created_at: new Date().toISOString(),
    }).returning('id');
    eventId = inserted[0]?.id ?? inserted[0];

    // The pre-fix corruption shape: epoch numbers in timestamp columns.
    await db('photos').insert({
      event_id: eventId,
      filename: 'restored.jpg',
      path: 'events/epoch/restored.jpg',
      type: 'individual',
      uploaded_at: Date.now() - 3600_000,
      captured_at: Date.now() - 7200_000,
    });

    const superRole = await db('roles').where({ name: 'super_admin' }).first();
    const [rootId] = await db('admin_users').insert({
      username: 'epoch-admin',
      email: 'epoch-admin@example.com',
      password_hash: await bcrypt.hash('EpochAdmin123', 4),
      role_id: superRole.id,
      is_active: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).returning('id').then((r) => [r[0]?.id || r[0]]);
    adminToken = jwt.sign(
      { id: rootId, username: 'epoch-admin', type: 'admin', role: 'super_admin', loginTime: Date.now() },
      process.env.JWT_SECRET,
      { expiresIn: '1h', issuer: 'picpeak-auth' }
    );

    await db('api_tokens').insert({
      name: 'epoch-token',
      hashed_token: 'x'.repeat(64),
      preview: 'pk_test…abcd',
      scopes: JSON.stringify(['events:read']),
      created_by: rootId,
      created_at: Date.now() - 86400_000,
      last_used_at: Date.now() - 3600_000,
      revoked_at: Date.now() - 60_000,
    });

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/gallery', require('../../src/routes/gallery'));
    app.use('/api/admin/api-tokens', require('../../src/routes/adminApiTokens'));
  }, 120000);

  afterAll(async () => {
    if (cleanup) await cleanup();
  });

  it('gallery /photos serializes epoch-stored uploaded_at/captured_at as ISO strings', async () => {
    const galleryToken = jwt.sign(
      { eventId, eventSlug: SLUG, type: 'gallery' },
      process.env.JWT_SECRET,
      { expiresIn: '1h', issuer: 'picpeak-auth' }
    );
    const res = await request(app)
      .get(`/api/gallery/${SLUG}/photos`)
      .set('Authorization', `Bearer ${galleryToken}`);
    expect(res.status).toBe(200);
    expect(res.body.photos).toHaveLength(1);
    const photo = res.body.photos[0];
    expect(typeof photo.uploaded_at).toBe('string');
    expect(photo.uploaded_at).toMatch(ISO_RE);
    expect(photo.captured_at).toMatch(ISO_RE);
  });

  it('api-tokens list serializes epoch-stored timestamps as ISO strings', async () => {
    const res = await request(app)
      .get('/api/admin/api-tokens')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const token = res.body.find((t) => t.name === 'epoch-token');
    expect(token).toBeTruthy();
    for (const field of ['created_at', 'last_used_at', 'revoked_at']) {
      expect(`${field}:${typeof token[field]}`).toBe(`${field}:string`);
      expect(token[field]).toMatch(ISO_RE);
    }
  });
});
