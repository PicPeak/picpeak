/**
 * v1 token scopes must intersect the owner's CURRENT role permissions
 * (GHSA-9697, codex round 2).
 *
 * Migration 081 documents effective permissions as the intersection of the
 * owner's role permissions and the token's scope flags. requireApiScope only
 * ever checked the scope half, so a token minted while its owner was
 * super_admin kept full write access after the owner was demoted to viewer —
 * userManagementService never touches api_tokens, so the token outlives the
 * demotion. Ownership scoping alone does not close this: the demoted owner
 * still *owns* their events.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-v1perm-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'v1perm-test-secret';
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-v1perm-storage-'));

const request = require('supertest');
const express = require('express');
const bcrypt = require('bcrypt');

const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');
const { generateApiToken } = require('../../src/middleware/apiTokenAuth');

describe('v1 token scopes intersect role permissions (GHSA-9697)', () => {
  let db; let cleanup; let app; let viewerToken; let viewerEventId;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);

    const role = await db('roles').where({ name: 'viewer' }).first();
    const r = await db('admin_users').insert({
      username: 'demoted-owner',
      email: 'demoted@example.com',
      password_hash: await bcrypt.hash('Passw0rd!', 4),
      role_id: role.id,
      is_active: 1,
      created_at: new Date(),
      updated_at: new Date(),
    }).returning('id');
    const ownerId = r[0]?.id ?? r[0];

    // A token still carrying the broad 'admin' scope from before demotion.
    const { plaintext, hashed } = generateApiToken();
    await db('api_tokens').insert({
      name: 'stale-token',
      hashed_token: hashed,
      scopes: 'admin',
      created_by: ownerId,
      created_at: new Date().toISOString(),
    });
    viewerToken = plaintext;

    const ev = await db('events').insert({
      slug: 'viewer-ev',
      event_type: 'wedding',
      event_name: 'Viewer Event',
      event_date: '2026-08-01',
      host_email: 'h@example.com',
      admin_email: 'a@example.com',
      password_hash: 'x',
      share_token: 'vtok',
      share_link: '/gallery/viewer-ev/vtok',
      created_by: ownerId,
      expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
      is_active: 1, is_archived: 0, is_draft: 0,
      created_at: new Date().toISOString(),
    }).returning('id');
    viewerEventId = ev[0]?.id ?? ev[0];

    app = express();
    app.use(express.json());
    app.use('/api/v1', require('../../src/routes/v1/events'));
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  it('denies event creation to a demoted viewer despite an admin-scope token', async () => {
    const res = await request(app)
      .post('/api/v1/events')
      .set('Authorization', `Bearer ${viewerToken}`)
      .send({ event_name: 'Nope', event_type: 'wedding' });
    expect(res.status).toBe(403);
  });

  it('denies photo upload to a demoted viewer on their OWN event', async () => {
    const res = await request(app)
      .post(`/api/v1/events/${viewerEventId}/photos`)
      .set('Authorization', `Bearer ${viewerToken}`)
      .attach('photo', Buffer.from('x'), 'a.jpg');
    expect(res.status).toBe(403);
  });

  it('still allows the viewer to READ their own event', async () => {
    const res = await request(app)
      .get(`/api/v1/events/${viewerEventId}`)
      .set('Authorization', `Bearer ${viewerToken}`);
    expect(res.status).toBe(200);
  });
});
