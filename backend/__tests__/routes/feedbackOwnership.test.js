/**
 * GHSA-2qc2 / GHSA-32h4 / GHSA-3335 — feedback moderation, deletion, and the
 * pending-moderation list are by-feedback-id (or global) and lacked ownership
 * scoping, so a restricted editor could act on / enumerate feedback for events
 * it does not own. super_admin keeps global access.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-fbown-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'fbown-test-secret';
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-fbown-storage-'));

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcrypt');
const { bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken } = require('../integration/helpers/crmDb');

describe('feedback ownership scoping', () => {
  let db; let cleanup; let app;
  let superTok; let editorTok; let editorId;
  let foreignFeedbackId;

  const auth = (req, tok) => req.set('Authorization', `Bearer ${tok}`);

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    const { adminId: superId } = await seedMinimal(db);
    await assignAdminRole(db, superId, 'super_admin');
    superTok = mintAdminToken(superId);

    const ins = await db('admin_users').insert({
      username: 'editor', email: 'editor@example.com',
      password_hash: await bcrypt.hash('x', 4), must_change_password: false, created_at: new Date(),
    }).returning('id');
    editorId = ins[0]?.id ?? ins[0];
    await assignAdminRole(db, editorId, 'editor');
    editorTok = mintAdminToken(editorId);

    // Event owned by super_admin (NOT the editor).
    const ev = await db('events').insert({
      slug: 'fbown-foreign', event_type: 'wedding', event_name: 'Foreign',
      event_date: '2026-08-01', host_email: 'h@e.com', admin_email: 'a@e.com',
      password_hash: 'x', share_link: '/g/fbown/s', share_token: 'fbown-share',
      expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
      is_active: 1, is_archived: 0, is_draft: 0, created_by: superId,
      created_at: new Date().toISOString(),
    }).returning('id');
    const eventId = ev[0]?.id ?? ev[0];
    const ph = await db('photos').insert({
      event_id: eventId, filename: 'p.jpg', path: 'fbown-foreign/p.jpg', type: 'individual',
      uploaded_at: new Date().toISOString(),
    }).returning('id');
    const photoId = ph[0]?.id ?? ph[0];
    const fb = await db('photo_feedback').insert({
      photo_id: photoId, event_id: eventId, feedback_type: 'comment',
      comment_text: 'hi', is_approved: 0, is_hidden: 0, created_at: new Date().toISOString(),
    }).returning('id');
    foreignFeedbackId = fb[0]?.id ?? fb[0];

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/admin/feedback', require('../../src/routes/adminFeedback'));
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  it('editor cannot moderate feedback on an event it does not own (404)', async () => {
    const res = await auth(request(app).put(`/api/admin/feedback/feedback/${foreignFeedbackId}/approve`), editorTok);
    expect(res.status).toBe(404);
    const row = await db('photo_feedback').where({ id: foreignFeedbackId }).first();
    expect([false, 0]).toContain(row.is_approved); // untouched
  });

  it('editor cannot delete foreign feedback, row survives', async () => {
    const res = await auth(request(app).delete(`/api/admin/feedback/feedback/${foreignFeedbackId}`), editorTok);
    // Denied either at the events.delete permission layer (editor lacks it →
    // 403) or the ownership layer (404) — both must leave the row intact.
    expect([403, 404]).toContain(res.status);
    expect(await db('photo_feedback').where({ id: foreignFeedbackId }).first()).toBeDefined();
  });

  it('editor sees no foreign feedback in pending-moderation', async () => {
    const res = await auth(request(app).get('/api/admin/feedback/feedback/pending-moderation'), editorTok);
    expect(res.status).toBe(200);
    expect(res.body.find((f) => f.id === foreignFeedbackId)).toBeUndefined();
  });

  it('super_admin CAN moderate and see it', async () => {
    const pending = await auth(request(app).get('/api/admin/feedback/feedback/pending-moderation'), superTok);
    expect(pending.body.find((f) => f.id === foreignFeedbackId)).toBeDefined();
    const res = await auth(request(app).put(`/api/admin/feedback/feedback/${foreignFeedbackId}/approve`), superTok);
    expect(res.status).toBe(200);
  });
});
