/**
 * v1 API tokens must respect event ownership (GHSA-9697).
 *
 * migration 081 documents the intent — "the token's effective permissions are
 * the intersection of the user's role permissions and the token's own scope
 * flags" — but it was never implemented:
 *
 *   - apiTokenAuth selected only id/username/email/role_id, so
 *     req.admin.roleName was undefined and every ownership helper (which all
 *     key on roleName) could not distinguish a super_admin from a viewer.
 *   - No v1 route applied requirePermission or a created_by predicate, so any
 *     valid token listed every event and — worst — GET /events/:id/share-link
 *     returned ANY event's share_token, which is the gallery access credential.
 *
 * Scenario pinned here: a token owned by a restricted (non-super_admin) admin
 * must see only its owner's events, and must not obtain a foreign share_token.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-v1own-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'v1own-test-secret';
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-v1own-storage-'));

const request = require('supertest');
const express = require('express');
const bcrypt = require('bcrypt');

const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');
const { generateApiToken } = require('../../src/middleware/apiTokenAuth');

describe('v1 event ownership (GHSA-9697)', () => {
  let db; let cleanup; let app;
  let editorToken; let superToken;
  let ownEventId; let foreignEventId;
  const FOREIGN_SHARE_TOKEN = 'f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0';

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
    return r[0]?.id ?? r[0];
  };

  const mkToken = async (adminId, scopes = 'admin') => {
    const { plaintext, hashed } = generateApiToken();
    await db('api_tokens').insert({
      name: `tok-${adminId}`,
      hashed_token: hashed,
      scopes,
      created_by: adminId,
      created_at: new Date().toISOString(),
    });
    return plaintext;
  };

  const mkEvent = async (slug, createdBy, shareToken) => {
    const r = await db('events').insert({
      slug,
      event_type: 'wedding',
      event_name: slug,
      event_date: '2026-08-01',
      host_email: 'h@example.com',
      admin_email: 'a@example.com',
      password_hash: 'x',
      share_token: shareToken,
      share_link: `/gallery/${slug}/${shareToken}`,
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

    const editorId = await mkAdmin('restricted-editor', 'editor');
    const superId = await mkAdmin('root-admin', 'super_admin');
    editorToken = await mkToken(editorId);
    superToken = await mkToken(superId);

    ownEventId = await mkEvent('own-event', editorId, 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1');
    foreignEventId = await mkEvent('foreign-event', superId, FOREIGN_SHARE_TOKEN);

    app = express();
    app.use(express.json());
    app.use('/api/v1', require('../../src/routes/v1/events'));
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  it('lists only the token owner\'s events', async () => {
    const res = await request(app)
      .get('/api/v1/events')
      .set('Authorization', `Bearer ${editorToken}`);

    expect(res.status).toBe(200);
    const slugs = res.body.events.map((e) => e.slug);
    expect(slugs).toContain('own-event');
    expect(slugs).not.toContain('foreign-event');
  });

  it('refuses to read a foreign event', async () => {
    const res = await request(app)
      .get(`/api/v1/events/${foreignEventId}`)
      .set('Authorization', `Bearer ${editorToken}`);

    expect([403, 404]).toContain(res.status);
  });

  it('does NOT hand out a foreign event\'s share_token', async () => {
    const res = await request(app)
      .get(`/api/v1/events/${foreignEventId}/share-link`)
      .set('Authorization', `Bearer ${editorToken}`);

    expect([403, 404]).toContain(res.status);
    expect(JSON.stringify(res.body)).not.toContain(FOREIGN_SHARE_TOKEN);
  });

  it('still allows the owner to read their own event and share link', async () => {
    const detail = await request(app)
      .get(`/api/v1/events/${ownEventId}`)
      .set('Authorization', `Bearer ${editorToken}`);
    expect(detail.status).toBe(200);

    const share = await request(app)
      .get(`/api/v1/events/${ownEventId}/share-link`)
      .set('Authorization', `Bearer ${editorToken}`);
    expect(share.status).toBe(200);
    expect(share.body.share_token).toBe('a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1');
  });

  it('leaves super_admin tokens unrestricted', async () => {
    const res = await request(app)
      .get(`/api/v1/events/${foreignEventId}/share-link`)
      .set('Authorization', `Bearer ${superToken}`);
    expect(res.status).toBe(200);
    expect(res.body.share_token).toBe(FOREIGN_SHARE_TOKEN);
  });
});
