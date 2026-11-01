/**
 * API-token access to gallery passwords (issue 2326).
 *
 * GET /api/v1/events/:id/password and POST /api/v1/events/:id/reset-password
 * each need their own gallery_passwords:* scope, which no other scope implies
 * (not even 'admin'). The owner rule is the admin routes' requireEventOwner:
 * a token of admin A never reaches admin B's gallery, and an assignment does
 * not hand the password over. A reveal answers "unavailable" instead of
 * failing when recoverable storage is off or nothing was saved. Both are in
 * the activity log under the token's owner, naming the token, never carrying
 * the password. Reads and resets are rate limited per token.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-v1gpw-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'v1gpw-test-secret';
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-v1gpw-storage-'));

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcrypt');

const { bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken } = require('../integration/helpers/crmDb');
const { generateApiToken, requireApiScope } = require('../../src/middleware/apiTokenAuth');
const vault = require('../../src/utils/galleryPasswordVault');

const PASSWORD = 'Meadow-Lark-77!';
const PIN = '432100';
const READ = 'gallery_passwords:read';
const RESET = 'gallery_passwords:reset';

describe('v1 gallery passwords (issue 2326)', () => {
  let db; let cleanup; let app;
  let editorId; let otherEditorId; let superId;
  let ownEventId; let foreignEventId; let assignedEventId; let archivedEventId;
  let tokenSeq = 0;
  let sessionToken;

  const setSetting = (value) => db('app_settings').insert({
    setting_key: vault.SETTING_KEY, setting_value: JSON.stringify(value), setting_type: 'security',
  }).onConflict('setting_key').merge({ setting_value: JSON.stringify(value) });

  const mkAdmin = async (username, roleName) => {
    const role = await db('roles').where({ name: roleName }).first();
    const r = await db('admin_users').insert({
      username,
      email: `${username}@example.com`,
      password_hash: await bcrypt.hash('Passw0rd!', 4),
      role_id: role.id,
      is_active: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).returning('id');
    return r[0]?.id ?? r[0];
  };

  // A fresh token per call, so the per-token limiter never bleeds between tests.
  const mkToken = async (adminId, scopes) => {
    const { plaintext, hashed } = generateApiToken();
    tokenSeq += 1;
    const r = await db('api_tokens').insert({
      name: `tok-${tokenSeq}`,
      hashed_token: hashed,
      scopes,
      created_by: adminId,
      created_at: new Date().toISOString(),
    }).returning('id');
    return { token: plaintext, id: r[0]?.id ?? r[0], name: `tok-${tokenSeq}` };
  };

  const mkEvent = async (slug, createdBy, over = {}) => {
    const r = await db('events').insert({
      slug,
      event_type: 'wedding',
      event_name: slug,
      event_date: '2026-08-01',
      host_email: 'h@example.com',
      admin_email: 'a@example.com',
      password_hash: await bcrypt.hash(PASSWORD, 4),
      require_password: 1,
      share_token: `${slug}-share-token-0000000000000000`,
      share_link: `/gallery/${slug}/x`,
      created_by: createdBy,
      expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
      is_active: 1, is_archived: 0, is_draft: 0,
      created_at: new Date().toISOString(),
      ...over,
    }).returning('id');
    return r[0]?.id ?? r[0];
  };

  const saveCopies = (id) => db('events').where({ id }).update({
    password_recoverable: vault.encryptPassword(PASSWORD),
    client_password_recoverable: vault.encryptPassword(PIN),
  });

  const read = (tok, id) => request(app).get(`/api/v1/events/${id}/password`)
    .set('Authorization', `Bearer ${tok.token}`);
  const reset = (tok, id, body = { send_email: false }) => request(app).post(`/api/v1/events/${id}/reset-password`)
    .set('Authorization', `Bearer ${tok.token}`).send(body);

  const lastLog = (type) => db('activity_logs').where({ activity_type: type }).orderBy('id', 'desc').first();

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    const { adminId } = await seedMinimal(db);
    await assignAdminRole(db, adminId, 'super_admin');
    sessionToken = mintAdminToken(adminId);

    editorId = await mkAdmin('gpw-editor', 'editor');
    otherEditorId = await mkAdmin('gpw-other-editor', 'editor');
    superId = await mkAdmin('gpw-root', 'super_admin');

    ownEventId = await mkEvent('gpw-own', editorId);
    foreignEventId = await mkEvent('gpw-foreign', otherEditorId);
    assignedEventId = await mkEvent('gpw-assigned', otherEditorId);
    archivedEventId = await mkEvent('gpw-archived', editorId, { is_archived: 1 });
    await db('event_admin_assignments').insert({ event_id: assignedEventId, admin_user_id: editorId, assigned_by: otherEditorId });

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/v1', require('../../src/routes/v1/events'));
    app.use('/api/admin/api-tokens', require('../../src/routes/adminApiTokens'));
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  beforeEach(async () => {
    await setSetting(true);
    await saveCopies(ownEventId);
    await saveCopies(foreignEventId);
    await saveCopies(assignedEventId);
  });

  describe('scopes', () => {
    it.each(['read', 'write', 'admin', 'read,write,admin', RESET])('a token with "%s" cannot read a password', async (scopes) => {
      const tok = await mkToken(editorId, scopes);
      const res = await read(tok, ownEventId);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('INSUFFICIENT_SCOPE');
      expect(JSON.stringify(res.body)).not.toContain(PASSWORD);
    });

    it.each(['read', 'write', 'admin', 'read,write,admin', READ])('a token with "%s" cannot reset a password', async (scopes) => {
      const tok = await mkToken(editorId, scopes);
      const before = (await db('events').where({ id: ownEventId }).first('password_hash')).password_hash;
      const res = await reset(tok, ownEventId);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('INSUFFICIENT_SCOPE');
      expect((await db('events').where({ id: ownEventId }).first('password_hash')).password_hash).toBe(before);
    });

    it('admin implies neither gallery_passwords scope, and neither implies the other', () => {
      const run = (scopes, scope) => {
        let passed = false;
        const res = { status: () => ({ json: () => {} }) };
        requireApiScope(scope)({ apiToken: { scopes } }, res, () => { passed = true; });
        return passed;
      };
      expect(run(['admin'], READ)).toBe(false);
      expect(run(['admin'], RESET)).toBe(false);
      expect(run([READ], RESET)).toBe(false);
      expect(run([RESET], READ)).toBe(false);
      expect(run([READ], 'read')).toBe(false);
      expect(run([READ], READ)).toBe(true);
      expect(run([RESET], RESET)).toBe(true);
    });

    it('the token admin route mints the new scopes, once each', async () => {
      const res = await request(app).post('/api/admin/api-tokens')
        .set('Authorization', `Bearer ${sessionToken}`)
        .send({ name: 'pw-tool', scopes: ['read', 'write', 'admin', READ, RESET, READ, RESET] });
      expect(res.status).toBe(201);
      expect(res.body.scopes).toEqual(['read', 'write', 'admin', READ, RESET]);
      const row = await db('api_tokens').where({ id: res.body.id }).first('scopes');
      expect(row.scopes).toBe(`read,write,admin,${READ},${RESET}`);
      expect(row.scopes.length).toBeLessThanOrEqual(64);
      expect((await read({ token: res.body.token }, ownEventId)).status).toBe(200);

      const bad = await request(app).post('/api/admin/api-tokens')
        .set('Authorization', `Bearer ${sessionToken}`)
        .send({ name: 'bad', scopes: ['gallery_passwords:*'] });
      expect(bad.status).toBe(400);
    });

    it('the role half still applies: a viewer token with the scope is refused', async () => {
      const viewerId = await mkAdmin('gpw-viewer', 'viewer');
      const ev = await mkEvent('gpw-viewer-own', viewerId);
      const tok = await mkToken(viewerId, `${READ},${RESET}`);
      expect((await read(tok, ev)).status).toBe(403);
      expect((await reset(tok, ev)).status).toBe(403);
    });
  });

  describe('ownership', () => {
    it('a token of admin A cannot read or reset admin B\'s gallery', async () => {
      const tok = await mkToken(editorId, `${READ},${RESET}`);
      const r = await read(tok, foreignEventId);
      expect(r.status).toBe(403);
      expect(JSON.stringify(r.body)).not.toContain(PASSWORD);
      const before = (await db('events').where({ id: foreignEventId }).first('password_hash')).password_hash;
      expect((await reset(tok, foreignEventId)).status).toBe(403);
      expect((await db('events').where({ id: foreignEventId }).first('password_hash')).password_hash).toBe(before);
    });

    it('an assignment does not hand the password over', async () => {
      const tok = await mkToken(editorId, `${READ},${RESET}`);
      expect((await read(tok, assignedEventId)).status).toBe(403);
      expect((await reset(tok, assignedEventId)).status).toBe(403);
    });

    it('an unknown event is a 404', async () => {
      const tok = await mkToken(superId, `${READ},${RESET}`);
      expect((await read(tok, 999999)).status).toBe(404);
      expect((await reset(tok, 999999)).status).toBe(404);
    });
  });

  describe('read', () => {
    it('returns both passwords when recoverable storage is on, no-store, and audits it', async () => {
      const tok = await mkToken(editorId, READ);
      const res = await read(tok, ownEventId);
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toMatch(/no-store/);
      expect(res.body).toEqual({ available: true, reason: null, enabled: true, password: PASSWORD, client_password: PIN });

      const log = await lastLog('gallery_password_viewed');
      expect(String(log.event_id)).toBe(String(ownEventId));
      expect(log.actor_type).toBe('admin');
      expect(Number(log.actor_id)).toBe(Number(editorId));
      expect(log.actor_name).toBe('gpw-editor');
      const meta = JSON.parse(log.metadata);
      expect(meta).toMatchObject({ via: 'api_token', apiTokenId: tok.id, apiTokenName: tok.name, galleryPassword: true, clientPassword: true });
      expect(log.metadata).not.toContain(PASSWORD);
      expect(log.metadata).not.toContain(PIN);
      expect(log.metadata).not.toContain(tok.token);
    });

    it('answers unavailable, not a 500 or the hash, when recoverable storage is off', async () => {
      await setSetting(false);
      const tok = await mkToken(editorId, READ);
      const res = await read(tok, ownEventId);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ available: false, reason: 'recoverable_storage_disabled', enabled: false, password: null, client_password: null });
      const ev = await db('events').where({ id: ownEventId }).first('password_hash');
      expect(JSON.stringify(res.body)).not.toContain(ev.password_hash);
    });

    it('answers unavailable when the setting is on but no copy was saved', async () => {
      const ev = await mkEvent('gpw-no-copy', editorId);
      const tok = await mkToken(editorId, READ);
      const res = await read(tok, ev);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ available: false, reason: 'no_saved_copy', enabled: true, password: null, client_password: null });
    });

    it('is rate limited per token', async () => {
      const tok = await mkToken(editorId, READ);
      for (let i = 0; i < 10; i += 1) {
        expect((await read(tok, ownEventId)).status).toBe(200);
      }
      const limited = await read(tok, ownEventId);
      expect(limited.status).toBe(429);
      expect(limited.body.code).toBe('RATE_LIMITED');
      expect(JSON.stringify(limited.body)).not.toContain(PASSWORD);
      // Another token of the same owner has its own budget.
      expect((await read(await mkToken(editorId, READ), ownEventId)).status).toBe(200);
    });
  });

  describe('reset', () => {
    it('sets the given password, works with recoverable storage off, and audits it', async () => {
      await setSetting(false);
      const tok = await mkToken(editorId, RESET);
      const res = await reset(tok, ownEventId, { password: 'Harbour-Light-91!', send_email: false });
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toMatch(/no-store/);
      expect(res.body).toEqual({ password: 'Harbour-Light-91!', email_sent: false });
      const ev = await db('events').where({ id: ownEventId }).first('password_hash', 'password_recoverable');
      expect(await bcrypt.compare('Harbour-Light-91!', ev.password_hash)).toBe(true);
      expect(ev.password_recoverable).toBeNull();

      const log = await lastLog('password_reset');
      expect(String(log.event_id)).toBe(String(ownEventId));
      expect(Number(log.actor_id)).toBe(Number(editorId));
      const meta = JSON.parse(log.metadata);
      expect(meta).toMatchObject({ emailSent: false, via: 'api_token', apiTokenId: tok.id, apiTokenName: tok.name });
      expect(log.metadata).not.toContain('Harbour-Light-91!');
      expect(log.metadata).not.toContain(tok.token);
    });

    it('generates a password when none is given and keeps the recoverable copy in step', async () => {
      const tok = await mkToken(editorId, RESET);
      const res = await reset(tok, ownEventId, { send_email: false });
      expect(res.status).toBe(200);
      expect(typeof res.body.password).toBe('string');
      expect(res.body.password.length).toBeGreaterThan(0);
      const ev = await db('events').where({ id: ownEventId }).first('password_hash', 'password_recoverable');
      expect(await bcrypt.compare(res.body.password, ev.password_hash)).toBe(true);
      expect(vault.decryptPassword(ev.password_recoverable)).toBe(res.body.password);
    });

    it('applies the gallery password rules', async () => {
      const tok = await mkToken(editorId, RESET);
      const res = await reset(tok, ownEventId, { password: 'a', send_email: false });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Password does not meet security requirements');
    });

    it('rejects a non-boolean send_email', async () => {
      const tok = await mkToken(editorId, RESET);
      expect((await reset(tok, ownEventId, { send_email: 'nope' })).status).toBe(400);
    });

    it('refuses an archived gallery', async () => {
      const tok = await mkToken(editorId, RESET);
      const res = await reset(tok, archivedEventId);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Cannot reset password for archived event');
    });

    it('is rate limited per token', async () => {
      const tok = await mkToken(editorId, RESET);
      for (let i = 0; i < 10; i += 1) {
        expect((await reset(tok, archivedEventId)).status).toBe(400);
      }
      expect((await reset(tok, archivedEventId)).status).toBe(429);
    });
  });

  describe('normal event responses', () => {
    it('GET /events/:id and GET /events never carry a password field', async () => {
      const tok = await mkToken(superId, 'admin');
      const detail = await request(app).get(`/api/v1/events/${ownEventId}`).set('Authorization', `Bearer ${tok.token}`);
      expect(detail.status).toBe(200);
      for (const key of ['password_hash', 'client_password_hash', 'password_recoverable', 'client_password_recoverable', 'password', 'client_password']) {
        expect(detail.body).not.toHaveProperty(key);
      }
      expect(JSON.stringify(detail.body)).not.toContain(PASSWORD);

      const list = await request(app).get('/api/v1/events').set('Authorization', `Bearer ${tok.token}`);
      expect(list.status).toBe(200);
      expect(JSON.stringify(list.body)).not.toMatch(/password_hash|password_recoverable/);
      expect(JSON.stringify(list.body)).not.toContain(PASSWORD);
    });
  });
});
