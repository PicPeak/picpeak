/**
 * Project ownership — GHSA-wrg5 (project routes) and GHSA-93x4 (project email
 * endpoints).
 *
 * Project routes authorized on generic events.view / events.edit with NO
 * ownership check, so an editor could enumerate, read, update and aggregate
 * projects belonging to other admins' events. The email endpoints keyed on an
 * email_queue id alone, so any id could be previewed/resent/cancelled.
 *
 * `projects` had no owner column. It was added in migration 167 (backfilled
 * from linked events) rather than relying only on the transitive
 * events.project_id -> events.created_by path, because a brand-new EMPTY
 * project has no linked event to infer an owner from — which is exactly where
 * the create -> attach flow begins.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-projown-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'projown-test-secret';

const request = require('supertest');
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');

describe('project ownership (GHSA-wrg5 / GHSA-93x4)', () => {
  let db; let cleanup; let app;
  let editorToken; let superToken; let editorId; let superId;
  let ownProjectId; let foreignProjectId; let foreignEventId; let foreignEmailId;

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
    const id = r[0]?.id ?? r[0];
    return {
      id,
      token: jwt.sign(
        { id, username, type: 'admin', role: roleName, loginTime: Date.now() },
        process.env.JWT_SECRET, { expiresIn: '1h', issuer: 'picpeak-auth' },
      ),
    };
  };

  const mkProject = async (name, createdBy) => {
    const r = await db('projects').insert({
      name, status: 'active', created_by: createdBy,
      created_at: new Date(), updated_at: new Date(),
    }).returning('id');
    return r[0]?.id ?? r[0];
  };

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);

    await db('feature_flags').insert({ key: 'projects', value: 1 })
      .onConflict('key').merge({ value: 1 });

    const editor = await mkAdmin('proj-editor', 'editor');
    const sup = await mkAdmin('proj-super', 'super_admin');
    editorToken = editor.token; editorId = editor.id;
    superToken = sup.token; superId = sup.id;

    ownProjectId = await mkProject('own-project', editorId);
    foreignProjectId = await mkProject('foreign-project', superId);

    // A foreign event linked to the foreign project, plus a queued email on it.
    const ev = await db('events').insert({
      slug: 'foreign-ev',
      event_type: 'wedding',
      event_name: 'Foreign Event',
      event_date: '2026-08-01',
      host_email: 'h@example.com',
      admin_email: 'a@example.com',
      password_hash: 'x',
      share_token: 'ftok', share_link: '/gallery/foreign-ev/ftok',
      created_by: superId,
      project_id: foreignProjectId,
      expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
      is_active: 1, is_archived: 0, is_draft: 0,
      created_at: new Date().toISOString(),
    }).returning('id');
    foreignEventId = ev[0]?.id ?? ev[0];

    const em = await db('email_queue').insert({
      event_id: foreignEventId,
      recipient_email: 'client@example.com',
      email_type: 'gallery_created',
      status: 'sent',
      created_at: new Date().toISOString(),
    }).returning('id');
    foreignEmailId = em[0]?.id ?? em[0];

    app = express();
    app.use(express.json());
    app.use('/api/admin/projects', require('../../src/routes/adminProjects'));
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  it('lists only the editor\'s own projects', async () => {
    const res = await request(app)
      .get('/api/admin/projects')
      .set('Authorization', `Bearer ${editorToken}`);

    expect(res.status).toBe(200);
    const names = (res.body.projects || res.body.data?.projects || []).map((p) => p.name);
    expect(names).toContain('own-project');
    expect(names).not.toContain('foreign-project');
  });

  it('refuses to read a foreign project', async () => {
    const res = await request(app)
      .get(`/api/admin/projects/${foreignProjectId}`)
      .set('Authorization', `Bearer ${editorToken}`);
    expect([403, 404]).toContain(res.status);
  });

  it('refuses to update or aggregate a foreign project', async () => {
    const update = await request(app)
      .put(`/api/admin/projects/${foreignProjectId}`)
      .set('Authorization', `Bearer ${editorToken}`)
      .send({ name: 'hijacked' });
    expect([403, 404]).toContain(update.status);

    const overview = await request(app)
      .get(`/api/admin/projects/${foreignProjectId}/overview`)
      .set('Authorization', `Bearer ${editorToken}`);
    expect([403, 404]).toContain(overview.status);

    // And the name must not have changed.
    const row = await db('projects').where({ id: foreignProjectId }).first();
    expect(row.name).toBe('foreign-project');
  });

  it('refuses to attach a FOREIGN event to an owned project', async () => {
    const res = await request(app)
      .post(`/api/admin/projects/${ownProjectId}/events`)
      .set('Authorization', `Bearer ${editorToken}`)
      .send({ eventId: foreignEventId });

    expect([403, 404]).toContain(res.status);
    const ev = await db('events').where({ id: foreignEventId }).first();
    expect(ev.project_id).toBe(foreignProjectId); // still attached to its own
  });

  it('refuses to preview or act on a foreign queued email (GHSA-93x4)', async () => {
    const preview = await request(app)
      .get(`/api/admin/projects/email/${foreignEmailId}/preview`)
      .set('Authorization', `Bearer ${editorToken}`);
    expect([403, 404]).toContain(preview.status);

    const cancel = await request(app)
      .post(`/api/admin/projects/email/${foreignEmailId}/cancel`)
      .set('Authorization', `Bearer ${editorToken}`);
    expect([403, 404]).toContain(cancel.status);
  });

  it('leaves super_admin unrestricted', async () => {
    const res = await request(app)
      .get(`/api/admin/projects/${foreignProjectId}`)
      .set('Authorization', `Bearer ${superToken}`);
    expect(res.status).toBe(200);
  });
});
