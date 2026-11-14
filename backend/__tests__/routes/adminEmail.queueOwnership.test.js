/**
 * The Messages queue routes and the project email routes share one rule
 * (middleware/emailQueueOwnership): an admin who is not a Super Admin reaches
 * the messages it wrote itself and the mail of galleries it may act on.
 * Seeing every gallery is not enough (gallery mail carries the share link),
 * and event-less mail it did not send (CRM document mail) answers 404 and
 * stays out of the list.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-queueowner-')), 'db.sqlite');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'queueowner-test-secret';
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-queueowner-storage-'));

const request = require('supertest');
const { bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp } = require('../integration/helpers/crmDb');
const { invalidateFeatureFlagCache } = require('../../src/middleware/requireFeatureFlag');
const { clearPermissionCache } = require('../../src/middleware/permissions');
const emailProcessor = require('../../src/services/emailProcessor');

const byId = (a, b) => a - b;

describe('Messages queue routes, senders and galleries', () => {
  let db; let cleanup; let app; let projectsApp;
  let superTok; let ownerTok; let otherTok; let studioTok; let teamTok;
  let ownerId; let otherId;
  let crmMail; let ownerMail; let otherMail; let assignedMail;

  const insertAdmin = async (username, roleId) => {
    const [row] = await db('admin_users').insert({
      username, email: `${username}@example.com`, password_hash: 'x', role_id: roleId,
      must_change_password: false, is_active: true, created_at: new Date(),
    }).returning('id');
    return row?.id ?? row;
  };
  const insertRole = async (name, permissions) => {
    const [row] = await db('roles').insert({ name, display_name: name, priority: 10 }).returning('id');
    const roleId = row?.id ?? row;
    const perms = await db('permissions').whereIn('name', permissions).select('id');
    await db('role_permissions').insert(perms.map((p) => ({ role_id: roleId, permission_id: p.id })));
    return roleId;
  };
  const insertEvent = async (slug, createdBy) => {
    const [row] = await db('events').insert({
      slug, event_name: slug, event_type: 'wedding', event_date: '2026-06-01',
      share_link: `/gallery/${slug}`, share_token: `${slug}-token`.padEnd(32, 'x'), password_hash: 'x',
      expires_at: '2027-01-01', created_by: createdBy, created_at: new Date().toISOString(),
    }).returning('id');
    return row?.id ?? row;
  };
  const insertMail = async (eventId, html, extra = {}) => {
    const [row] = await db('email_queue').insert({
      event_id: eventId, recipient_email: 'client@example.com', email_type: eventId ? 'gallery_created' : 'invoice_sent',
      status: 'sent', created_at: new Date().toISOString(), sent_at: new Date().toISOString(), retry_count: 0,
      email_data: JSON.stringify({}), rendered_html: html, ...extra,
    }).returning('id');
    return row?.id ?? row;
  };
  const as = (req, tok) => req.set('Authorization', `Bearer ${tok}`);
  const listed = async (tok) => {
    const res = await as(request(app).get('/api/admin/email/queue'), tok);
    expect(res.status).toBe(200);
    return res.body.items.map((i) => i.id).sort(byId);
  };

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    const { adminId: superId } = await seedMinimal(db);
    await assignAdminRole(db, superId, 'super_admin');
    superTok = mintAdminToken(superId);

    // Two photographers scoped to their own galleries, with mail access.
    const scopedRole = await insertRole('mail_photographer', ['email.view', 'email.edit', 'email.send', 'events.view']);
    ownerId = await insertAdmin('mail_owner', scopedRole);
    ownerTok = mintAdminToken(ownerId);
    otherId = await insertAdmin('mail_other', scopedRole);
    otherTok = mintAdminToken(otherId);
    // The built-in admin role sees every gallery, but reaches only the mail
    // of its own.
    const studioId = await insertAdmin('mail_studio', null);
    await assignAdminRole(db, studioId, 'admin');
    studioTok = mintAdminToken(studioId);
    // A team member assigned to the other photographer's second gallery.
    const teamId = await insertAdmin('mail_team', scopedRole);
    teamTok = mintAdminToken(teamId);

    const ownerEvent = await insertEvent('owner-gallery', ownerId);
    const otherEvent = await insertEvent('other-gallery', otherId);
    const assignedEvent = await insertEvent('assigned-gallery', otherId);
    await db('event_admin_assignments').insert({ event_id: assignedEvent, admin_user_id: teamId, assigned_by: otherId });

    crmMail = await insertMail(null, '<p>INV-TEST-1 total 1.00</p>');
    ownerMail = await insertMail(ownerEvent, '<p>owner gallery mail</p>');
    otherMail = await insertMail(otherEvent, '<p>other gallery mail</p>');
    assignedMail = await insertMail(assignedEvent, '<p>assigned gallery mail</p>');

    await db('feature_flags').insert({ key: 'messaging', value: true }).onConflict('key').merge({ value: true });
    invalidateFeatureFlagCache();
    clearPermissionCache();
    app = buildRouteApp('/api/admin/email', require('../../src/routes/adminEmail'));
    await db('feature_flags').insert({ key: 'projects', value: true }).onConflict('key').merge({ value: true });
    invalidateFeatureFlagCache();
    projectsApp = buildRouteApp('/api/admin/projects', require('../../src/routes/adminProjects'));
  }, 120000);
  afterAll(async () => { jest.restoreAllMocks(); if (cleanup) await cleanup(); });

  it('lists a scoped admin only the mail of its own galleries', async () => {
    expect(await listed(ownerTok)).toEqual([ownerMail]);
  });

  it('lists everything for a Super Admin', async () => {
    expect(await listed(superTok)).toEqual([crmMail, ownerMail, otherMail, assignedMail].sort(byId));
  });

  it('lists a role that sees all galleries none of another owner\'s gallery mail', async () => {
    expect(await listed(studioTok)).toEqual([]);
  });

  it('keeps an admin\'s own composed message in its Sent folder, and only there', async () => {
    jest.spyOn(emailProcessor, 'sendRawEmail').mockResolvedValue({ messageId: '<m1@example.com>', transport: 'smtp' });
    const sent = await as(request(app).post('/api/admin/email/send'), ownerTok)
      .send({ to: 'client@example.com', subject: 'Your session', html: '<p>See you Saturday</p>' });
    expect(sent.status).toBe(200);
    const row = await db('email_queue').where({ email_type: 'manual_message', recipient_email: 'client@example.com' }).first();
    expect(Number(row.sent_by_admin_id)).toBe(Number(ownerId));
    expect(row.event_id).toBeNull();

    expect(await listed(ownerTok)).toEqual([ownerMail, row.id].sort(byId));
    const read = await as(request(app).get(`/api/admin/email/queue/${row.id}`), ownerTok);
    expect(read.status).toBe(200);
    expect(read.body.renderedHtml).toContain('See you Saturday');
    expect((await as(request(app).post(`/api/admin/email/item/queue/${row.id}/state`), ownerTok).send({ state: 'archived' })).status).toBe(200);
    expect((await as(request(app).post(`/api/admin/email/item/queue/${row.id}/state`), ownerTok).send({ state: 'active' })).status).toBe(200);

    // Another photographer, and the studio admin, do not reach it.
    expect(await listed(otherTok)).not.toContain(row.id);
    expect(await listed(studioTok)).not.toContain(row.id);
    expect((await as(request(app).get(`/api/admin/email/queue/${row.id}`), otherTok)).status).toBe(404);
    expect((await as(request(app).delete(`/api/admin/email/item/queue/${row.id}`), studioTok)).status).toBe(404);
    expect(await db('email_queue').where({ id: row.id }).first()).toBeTruthy();
  });

  it('never opens another admin\'s event-less document mail', async () => {
    for (const tok of [ownerTok, otherTok, studioTok, teamTok]) {
      const res = await as(request(app).get(`/api/admin/email/queue/${crmMail}`), tok);
      expect(res.status).toBe(404);
      expect(JSON.stringify(res.body)).not.toContain('INV-TEST-1');
    }
    expect((await as(request(app).get(`/api/admin/email/queue/${crmMail}`), superTok)).status).toBe(200);
  });

  it('keeps another owner\'s gallery mail, and its share link, from a role that sees all galleries', async () => {
    expect((await as(request(app).get(`/api/admin/email/queue/${otherMail}`), studioTok)).status).toBe(404);
    // The project cockpit's preview holds the same line.
    expect((await as(request(projectsApp).get(`/api/admin/projects/email/${otherMail}/preview`), studioTok)).status).toBe(404);
    expect((await as(request(projectsApp).get(`/api/admin/projects/email/${otherMail}/preview`), otherTok)).status).toBe(200);
    expect((await as(request(app).post(`/api/admin/email/item/queue/${otherMail}/state`), studioTok).send({ state: 'deleted' })).status).toBe(404);
    expect((await as(request(app).delete(`/api/admin/email/item/queue/${otherMail}`), studioTok)).status).toBe(404);
  });

  it('gives an assigned team member the mail of its assigned gallery', async () => {
    expect(await listed(teamTok)).toEqual([assignedMail]);
    expect((await as(request(app).get(`/api/admin/email/queue/${assignedMail}`), teamTok)).status).toBe(200);
    expect((await as(request(app).post(`/api/admin/email/item/queue/${assignedMail}/state`), teamTok).send({ state: 'archived' })).status).toBe(200);
    await db('email_queue').where({ id: assignedMail }).update({ mailbox_state: 'active' });
  });

  it('does not archive or delete another owner\'s or event-less mail', async () => {
    for (const id of [crmMail, otherMail]) {
      expect((await as(request(app).post(`/api/admin/email/item/queue/${id}/state`), ownerTok).send({ state: 'deleted' })).status).toBe(404);
      expect((await as(request(app).delete(`/api/admin/email/item/queue/${id}`), ownerTok)).status).toBe(404);
    }
    const rows = await db('email_queue').whereIn('id', [crmMail, otherMail]).select('id', 'mailbox_state');
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.mailbox_state == null || r.mailbox_state === 'active')).toBe(true);
  });

  it('checks and reads the same row for a non-canonical id', async () => {
    // An owned row at 10 x crmMail: SQLite matches `${crmMail}e1` to it, while
    // parseInt reads crmMail, the event-less document mail.
    const ownerEvent = (await db('email_queue').where({ id: ownerMail }).first()).event_id;
    await insertMail(ownerEvent, '<p>owner second mail</p>', { id: crmMail * 100 });
    for (const raw of [`${crmMail}e2`, `${crmMail * 100}.0`, ` ${crmMail * 100}`, `+${crmMail * 100}`]) {
      const res = await as(request(app).get(`/api/admin/email/queue/${encodeURIComponent(raw)}`), ownerTok);
      expect(res.status).toBe(404);
      expect(JSON.stringify(res.body)).not.toContain('INV-TEST-1');
    }
    expect((await as(request(app).get(`/api/admin/email/queue/${crmMail * 100}`), ownerTok)).status).toBe(200);
    await db('email_queue').where({ id: crmMail * 100 }).del();
  });

  it('makes the admin who resends mail without a gallery the sender of the copy', async () => {
    const { resendEmail } = require('../../src/services/projectService');
    const { id } = await resendEmail(crmMail, otherId);
    const copy = await db('email_queue').where({ id }).first();
    expect(Number(copy.sent_by_admin_id)).toBe(Number(otherId));
    await db('email_queue').where({ id }).del();
    // Gallery mail keeps following its gallery: no sender on the copy.
    const { id: galleryCopy } = await resendEmail(assignedMail, otherId);
    expect((await db('email_queue').where({ id: galleryCopy }).first()).sent_by_admin_id).toBeNull();
    await db('email_queue').where({ id: galleryCopy }).del();
  });

  it('still archives and deletes the caller\'s own gallery mail', async () => {
    expect((await as(request(app).post(`/api/admin/email/item/queue/${ownerMail}/state`), ownerTok).send({ state: 'archived' })).status).toBe(200);
    expect((await db('email_queue').where({ id: ownerMail }).first()).mailbox_state).toBe('archived');
    expect((await as(request(app).delete(`/api/admin/email/item/queue/${ownerMail}`), ownerTok)).status).toBe(200);
    expect(await db('email_queue').where({ id: ownerMail }).first()).toBeUndefined();
  });
});
