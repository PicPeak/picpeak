/**
 * Team members on a gallery and review of their uploads (issue 743,
 * migration 269).
 *
 * Pins the contract:
 *  - an admin assigned to an event reaches its gallery the way the creator
 *    does (list, detail with links, photo routes), capped by its role; an
 *    unassigned admin of the same role does not
 *  - CRM callers of filterOwnedEventIds stay owner-only; gallery callers
 *    (honourManageAll) take the assignment
 *  - only the owner changes the team or the review switch; a team member's
 *    echo of the stored values is let through
 *  - with review on, a team member's upload is stored hidden + pending and
 *    tagged with the account; the owner's is not
 *  - only the owner approves or rejects; visibility routes do not publish a
 *    photo under review
 *  - no gallery viewer sees a photo under review, the PIN client included
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-team-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'team-test-secret';
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-team-storage-'));

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const sharp = require('sharp');
const { bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken } = require('../integration/helpers/crmDb');

describe('gallery team members and upload review (issue 743)', () => {
  let db; let cleanup; let app; let jpeg;
  const tok = {};
  const id = {};

  const as = (req, who) => req.set('Authorization', `Bearer ${tok[who]}`);
  const now = () => new Date().toISOString();

  async function mkAdmin(name, roleName) {
    const rows = await db('admin_users').insert({
      username: `team-${name}`,
      email: `team-${name}@example.com`,
      password_hash: 'x',
      must_change_password: false,
      created_at: now(),
    }).returning('id');
    const adminId = rows[0]?.id ?? rows[0];
    await assignAdminRole(db, adminId, roleName);
    tok[name] = mintAdminToken(adminId);
    return adminId;
  }

  async function mkEvent(slug, createdBy) {
    const rows = await db('events').insert({
      slug,
      event_type: 'wedding',
      event_name: slug,
      event_date: '2026-08-01',
      host_email: 'h@example.com',
      admin_email: 'a@example.com',
      password_hash: 'x',
      share_token: `st-${slug}`,
      share_link: `/gallery/${slug}/st-${slug}`,
      created_by: createdBy,
      expires_at: new Date(Date.now() + 30 * 864e5).toISOString(),
      is_active: 1,
      is_archived: 0,
      is_draft: 0,
      created_at: now(),
    }).returning('id');
    return rows[0]?.id ?? rows[0];
  }

  const upload = (who, eventId) => as(request(app).post(`/api/admin/photos/${eventId}/upload`), who)
    .attach('photos', jpeg, { filename: `${who}.jpg`, contentType: 'image/jpeg' });

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);
    jpeg = await sharp({ create: { width: 32, height: 24, channels: 3, background: { r: 10, g: 120, b: 200 } } })
      .jpeg().toBuffer();

    id.owner = await mkAdmin('owner', 'editor');
    id.team = await mkAdmin('team', 'team_photographer');
    id.editorMember = await mkAdmin('editor-member', 'editor');
    id.stranger = await mkAdmin('stranger', 'team_photographer');
    id.inactive = await mkAdmin('inactive', 'team_photographer');
    await db('admin_users').where({ id: id.inactive }).update({ is_active: false });

    id.event = await mkEvent('team-gallery', id.owner);
    await fs.promises.mkdir(path.join(process.env.STORAGE_PATH, 'events', 'active', 'team-gallery'), { recursive: true });

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/admin/events', require('../../src/routes/adminEvents'));
    app.use('/api/admin/photos', require('../../src/routes/adminPhotos'));
    app.use('/api/admin/archives', require('../../src/routes/adminArchives'));
    app.use('/api/admin/external-media', require('../../src/routes/adminExternalMedia'));
    app.use('/api/gallery', require('../../src/routes/gallery'));
    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => {
      res.status(err.statusCode || err.status || 500).json({ error: err.message });
    });
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  describe('assigning the team', () => {
    it('offers active admin accounts to events.edit holders, without emails', async () => {
      const res = await as(request(app).get('/api/admin/events/assignable-admins'), 'owner');
      expect(res.status).toBe(200);
      const names = res.body.admins.map((a) => a.username);
      expect(names).toEqual(expect.arrayContaining(['team-team', 'team-stranger']));
      expect(names).not.toContain('team-inactive');
      expect(res.body.admins[0]).not.toHaveProperty('email');

      // The Team Photographer preset has no events.edit.
      const denied = await as(request(app).get('/api/admin/events/assignable-admins'), 'team');
      expect(denied.status).toBe(403);
    });

    it('lets the owner replace the team, and refuses inactive or unknown accounts', async () => {
      const bad = await as(request(app).put(`/api/admin/events/${id.event}`), 'owner')
        .send({ assigned_admin_ids: [id.team, id.inactive] });
      expect(bad.status).toBe(400);
      expect(bad.body.code).toBe('INVALID_ASSIGNED_ADMINS');

      const res = await as(request(app).put(`/api/admin/events/${id.event}`), 'owner')
        .send({ assigned_admin_ids: [id.team, id.editorMember, id.owner] });
      expect(res.status).toBe(200);
      const rows = await db('event_admin_assignments').where({ event_id: id.event }).pluck('admin_user_id');
      expect(rows.map(Number).sort()).toEqual([id.team, id.editorMember].sort());

      const detail = await as(request(app).get(`/api/admin/events/${id.event}`), 'owner');
      expect(detail.body.can_manage_assignments).toBe(true);
      expect(detail.body.assigned_admins.map((a) => a.username).sort()).toEqual(['team-editor-member', 'team-team']);
    });

    it('takes the team and the review switch on create, and leaves the creator out', async () => {
      const res = await as(request(app).post('/api/admin/events'), 'owner').send({
        event_type: 'wedding', event_name: 'Team Created', event_date: '2026-09-01',
        customer_name: 'Client', customer_email: 'client@example.com', admin_email: 'admin@example.com',
        require_password: false, is_draft: true,
        assigned_admin_ids: [id.team, id.owner], review_contributor_uploads: true,
      });
      expect(res.status).toBe(200);
      const created = await db('events').where({ event_name: 'Team Created' }).first();
      expect(Boolean(created.review_contributor_uploads)).toBe(true);
      const rows = await db('event_admin_assignments').where({ event_id: created.id }).pluck('admin_user_id');
      expect(rows.map(Number)).toEqual([id.team]);

      const bad = await as(request(app).post('/api/admin/events'), 'owner').send({
        event_type: 'wedding', event_name: 'Team Refused', event_date: '2026-09-01',
        customer_name: 'Client', customer_email: 'client@example.com', admin_email: 'admin@example.com',
        require_password: false, is_draft: true, assigned_admin_ids: [id.inactive],
      });
      expect(bad.status).toBe(400);
      expect(await db('events').where({ event_name: 'Team Refused' }).first()).toBeUndefined();
    });

    it('does not let a team member change the team or the review switch', async () => {
      const team = await as(request(app).put(`/api/admin/events/${id.event}`), 'editor-member')
        .send({ assigned_admin_ids: [id.editorMember, id.stranger] });
      expect(team.status).toBe(403);
      expect(team.body.code).toBe('EVENT_OWNER_REQUIRED');

      const review = await as(request(app).put(`/api/admin/events/${id.event}`), 'editor-member')
        .send({ review_contributor_uploads: true });
      expect(review.status).toBe(403);

      // The settings form's echo of the stored values changes nothing.
      const echo = await as(request(app).put(`/api/admin/events/${id.event}`), 'editor-member')
        .send({ assigned_admin_ids: [id.team, id.editorMember], review_contributor_uploads: false, welcome_message: 'Hi' });
      expect(echo.status).toBe(200);
      expect((await db('events').where({ id: id.event }).first()).welcome_message).toBe('Hi');

      const detail = await as(request(app).get(`/api/admin/events/${id.event}`), 'editor-member');
      expect(detail.body.can_manage_assignments).toBe(false);
    });
  });

  describe('reach of an assignment', () => {
    it('lists the gallery, with its links, for the assigned admin and not for an unassigned one', async () => {
      const team = await as(request(app).get('/api/admin/events').query({ limit: 100 }), 'team');
      expect(team.status).toBe(200);
      const event = team.body.events.find((e) => e.id === id.event);
      expect(event.share_token).toBe('st-team-gallery');

      const stranger = await as(request(app).get('/api/admin/events').query({ limit: 100 }), 'stranger');
      expect(stranger.body.events.map((e) => e.id)).not.toContain(id.event);
      expect((await as(request(app).get(`/api/admin/events/${id.event}`), 'stranger')).status).toBe(404);
    });

    it('passes the photo routes for the assigned admin only', async () => {
      expect((await as(request(app).get(`/api/admin/photos/${id.event}/photos`), 'team')).status).toBe(200);
      expect((await as(request(app).get(`/api/admin/photos/${id.event}/photos`), 'stranger')).status).toBe(403);
    });

    it('keeps CRM callers of filterOwnedEventIds owner-only', async () => {
      const { filterOwnedEventIds, loadAssignedEventIds, scopeEventsQuery } = require('../../src/middleware/ownership');
      const { roleEventScope } = require('../../src/middleware/permissions');
      const principal = {
        id: id.team,
        roleName: 'team_photographer',
        eventScope: await roleEventScope('team_photographer'),
        assignedEventIds: await loadAssignedEventIds(id.team),
      };
      expect(principal.assignedEventIds).toContain(id.event);

      expect((await filterOwnedEventIds(principal, [id.event])).denied).toEqual([id.event]);
      // The bulk callers delete and archive, which stay the owner's.
      expect((await filterOwnedEventIds(principal, [id.event], { honourManageAll: true })).denied).toEqual([id.event]);

      const scoped = await scopeEventsQuery(db('events'), principal).pluck('id');
      expect(scoped.map(Number)).toContain(id.event);
      const viaJoinColumn = await scopeEventsQuery(db('events'), principal, 'events.created_by').pluck('events.id');
      expect(viaJoinColumn.map(Number)).toContain(id.event);
    });
  });

  describe('review of team members\' uploads', () => {
    let pendingId; let ownerPhotoId;

    beforeAll(async () => {
      const on = await as(request(app).put(`/api/admin/events/${id.event}`), 'owner')
        .send({ review_contributor_uploads: true });
      expect(on.status).toBe(200);
    });

    it('holds a team member\'s upload hidden + pending and leaves the owner\'s alone', async () => {
      const team = await upload('team', id.event);
      expect(team.status).toBe(202);
      pendingId = team.body.photo_ids[0];
      expect(await db('photos').where({ id: pendingId }).first()).toMatchObject({
        visibility: 'hidden', moderation_status: 'pending', uploaded_by_admin_id: id.team,
      });

      const owner = await upload('owner', id.event);
      expect(owner.status).toBe(202);
      ownerPhotoId = owner.body.photo_ids[0];
      const row = await db('photos').where({ id: ownerPhotoId }).first();
      expect(row.moderation_status).toBeNull();
      expect(row.visibility).not.toBe('hidden');
      expect(row.uploaded_by_admin_id).toBe(id.owner);

      await db('photos').where('event_id', id.event).update({ processing_status: 'complete' });
    });

    it('filters and counts the photos under review for the admin grid', async () => {
      const res = await as(request(app).get(`/api/admin/photos/${id.event}/photos`).query({ moderation: 'pending' }), 'owner');
      expect(res.status).toBe(200);
      expect(res.body.photos.map((p) => p.id)).toEqual([pendingId]);
      expect(res.body.photos[0].uploaded_by_admin).toEqual({ id: id.team, username: 'team-team' });

      const counts = await as(request(app).get(`/api/admin/photos/${id.event}/photos/moderation`), 'team');
      expect(counts.status).toBe(200);
      expect(counts.body.moderation).toEqual({ pending: 1, rejected: 0 });
    });

    it('keeps the photo under review from guests and from the PIN client', async () => {
      const event = await db('events').where({ id: id.event }).first();
      for (const accessLevel of ['client', undefined]) {
        const token = jwt.sign(
          { eventId: event.id, eventSlug: event.slug, type: 'gallery', ...(accessLevel ? { accessLevel } : {}) },
          process.env.JWT_SECRET, { expiresIn: '1h', issuer: 'picpeak-auth' });
        const res = await request(app).get(`/api/gallery/${event.slug}/photos`).set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(200);
        const ids = res.body.photos.map((p) => p.id);
        expect(ids).toContain(ownerPhotoId);
        expect(ids).not.toContain(pendingId);
      }
    });

    it('does not publish a photo under review through the visibility routes', async () => {
      const single = await as(request(app).patch(`/api/admin/photos/${id.event}/photos/${pendingId}`), 'owner')
        .send({ visibility: 'visible' });
      expect(single.status).toBe(409);
      expect(single.body.code).toBe('PHOTO_UNDER_REVIEW');

      const bulk = await as(request(app).post(`/api/admin/photos/${id.event}/photos/bulk-update`), 'owner')
        .send({ photoIds: [pendingId, ownerPhotoId], updates: { visibility: 'visible' } });
      expect(bulk.status).toBe(200);
      expect(bulk.body.skipped_under_review).toBe(1);
      expect((await db('photos').where({ id: pendingId }).first()).visibility).toBe('hidden');
    });

    it('does not make a photo under review the public cover', async () => {
      const res = await as(request(app).put(`/api/admin/events/${id.event}`), 'owner')
        .send({ hero_photo_id: pendingId });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('PHOTO_UNDER_REVIEW');
      expect((await db('events').where({ id: id.event }).first()).hero_photo_id).not.toBe(pendingId);
    });

    it('refuses a folder import from a team member whose uploads are reviewed', async () => {
      const before = await db('photos').where('event_id', id.event).count('id as c').first();
      const res = await as(request(app).post(`/api/admin/external-media/events/${id.event}/import-external`), 'team')
        .send({ external_path: 'anything' });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('UPLOAD_REVIEW_REQUIRED');
      const after = await db('photos').where('event_id', id.event).count('id as c').first();
      expect(Number(after.c)).toBe(Number(before.c));
    });

    it('lets only the owner approve or reject', async () => {
      const team = await as(request(app).post(`/api/admin/photos/${id.event}/photos/moderation`), 'team')
        .send({ photoIds: [pendingId], action: 'approve' });
      expect(team.status).toBe(403);
      expect((await db('photos').where({ id: pendingId }).first()).moderation_status).toBe('pending');

      const reject = await as(request(app).post(`/api/admin/photos/${id.event}/photos/moderation`), 'owner')
        .send({ photoIds: [pendingId], action: 'reject' });
      expect(reject.status).toBe(200);
      expect(reject.body).toMatchObject({ updated: 1, moderation: { pending: 0, rejected: 1 } });
      expect(await db('photos').where({ id: pendingId }).first()).toMatchObject({ visibility: 'hidden', moderation_status: 'rejected' });

      const approve = await as(request(app).post(`/api/admin/photos/${id.event}/photos/moderation`), 'owner')
        .send({ photoIds: [pendingId, ownerPhotoId], action: 'approve' });
      expect(approve.status).toBe(200);
      expect(approve.body.updated).toBe(1);
      expect(await db('photos').where({ id: pendingId }).first()).toMatchObject({ visibility: 'visible', moderation_status: null });
    });

    it('validates the moderation request', async () => {
      const badAction = await as(request(app).post(`/api/admin/photos/${id.event}/photos/moderation`), 'owner')
        .send({ photoIds: [pendingId], action: 'publish' });
      expect(badAction.status).toBe(400);
      const badIds = await as(request(app).post(`/api/admin/photos/${id.event}/photos/moderation`), 'owner')
        .send({ photoIds: ['1'], action: 'approve' });
      expect(badIds.status).toBe(400);
    });

    it('credits an upload without an EXIF name to the account credit name, never the login', async () => {
      const { creditOpenForExif, accountCreditName } = require('../../src/services/photoCredit');
      // No credit name: no credit at all, not the username.
      await db('admin_users').where({ id: id.owner }).update({ credit_name: null });
      const bare = await upload('owner', id.event);
      expect(await db('photos').where({ id: bare.body.photo_ids[0] }).first())
        .toMatchObject({ credit_name: null, credit_source: null });

      await db('admin_users').where({ id: id.owner }).update({ credit_name: 'Studio Lena' });
      const named = await upload('owner', id.event);
      const row = await db('photos').where({ id: named.body.photo_ids[0] }).first();
      expect(row).toMatchObject({ credit_name: 'Studio Lena', credit_source: 'account' });
      // EXIF found later by the worker or the backfill still replaces it.
      expect(creditOpenForExif(row)).toBe(true);

      expect(accountCreditName('  ')).toEqual({ value: null });
      expect(accountCreditName('<>').error).toBeTruthy();
      await db('admin_users').where({ id: id.owner }).update({ credit_name: null });
    });

    it('lets a project lead holding photos.review review, and does not hold its own uploads', async () => {
      // Migration 269 projects photos.review onto the roles holding both
      // photos.edit and events.edit; Team Photographer holds only photos.edit.
      const holds = async (roleName) => Boolean(await db('role_permissions')
        .join('roles', 'roles.id', 'role_permissions.role_id')
        .join('permissions', 'permissions.id', 'role_permissions.permission_id')
        .where({ 'roles.name': roleName, 'permissions.name': 'photos.review' }).first());
      expect(await holds('editor')).toBe(true);
      expect(await holds('super_admin')).toBe(true);
      expect(await holds('team_photographer')).toBe(false);

      // A custom role with photos.review and no photos.edit.
      const [roleRow] = await db('roles').insert({
        name: 'project_lead', display_name: 'Project lead', is_system: false, priority: 45,
        created_at: now(), updated_at: now(),
      }).returning('id');
      const roleId = roleRow?.id ?? roleRow;
      const perms = await db('permissions')
        .whereIn('name', ['events.view', 'photos.view', 'photos.upload', 'photos.review']).select('id');
      await db('role_permissions').insert(perms.map((p) => ({ role_id: roleId, permission_id: p.id })));
      require('../../src/middleware/permissions').clearPermissionCache();
      id.lead = await mkAdmin('lead', 'project_lead');
      await db('event_admin_assignments').insert({ event_id: id.event, admin_user_id: id.lead, assigned_by: id.owner });
      await db('events').where({ id: id.event }).update({ review_contributor_uploads: true });

      const detail = await as(request(app).get(`/api/admin/events/${id.event}`), 'lead');
      expect(detail.body.can_review_uploads).toBe(true);
      expect(detail.body.can_manage_assignments).toBe(false);

      const own = await upload('lead', id.event);
      expect(own.status).toBe(202);
      expect((await db('photos').where({ id: own.body.photo_ids[0] }).first()).moderation_status).toBeNull();

      const team = await upload('team', id.event);
      const heldId = team.body.photo_ids[0];
      expect((await db('photos').where({ id: heldId }).first()).moderation_status).toBe('pending');
      const approve = await as(request(app).post(`/api/admin/photos/${id.event}/photos/moderation`), 'lead')
        .send({ photoIds: [heldId], action: 'approve' });
      expect(approve.status).toBe(200);
      expect(approve.body.updated).toBe(1);

      // Not on a gallery it does not reach.
      const other = await mkEvent('lead-not-assigned', id.owner);
      const foreign = await as(request(app).post(`/api/admin/photos/${other}/photos/moderation`), 'lead')
        .send({ photoIds: [heldId], action: 'approve' });
      expect(foreign.status).toBe(403);
    });
  });

  describe('what an assignment does not hand over (review round 1)', () => {
    let eventId;

    beforeAll(async () => {
      // A custom role that runs galleries but was created after migration
      // 269, so it holds events.edit and photos.edit without photos.review:
      // its uploads are held.
      const [roleRow] = await db('roles').insert({
        name: 'gallery_hand', display_name: 'Gallery hand', is_system: false, priority: 44,
        created_at: now(), updated_at: now(),
      }).returning('id');
      const roleId = roleRow?.id ?? roleRow;
      const perms = await db('permissions').whereIn('name', [
        'events.view', 'events.edit', 'events.delete', 'events.archive', 'events.support',
        'archives.view', 'archives.delete', 'photos.view', 'photos.upload', 'photos.edit',
      ]).select('id');
      await db('role_permissions').insert(perms.map((p) => ({ role_id: roleId, permission_id: p.id })));
      require('../../src/middleware/permissions').clearPermissionCache();
      id.hand = await mkAdmin('hand', 'gallery_hand');

      eventId = await mkEvent('round-one', id.owner);
      await db('events').where({ id: eventId }).update({ review_contributor_uploads: true });
      await fs.promises.mkdir(path.join(process.env.STORAGE_PATH, 'events', 'active', 'round-one'), { recursive: true });
      await db('event_admin_assignments').insert([
        { event_id: eventId, admin_user_id: id.hand, assigned_by: id.owner },
        { event_id: eventId, admin_user_id: id.team, assigned_by: id.owner },
      ]);
    });

    it('keeps delete, archive and the stored password with the owner', async () => {
      const ok = await as(request(app).get(`/api/admin/events/${eventId}`), 'hand');
      expect(ok.status).toBe(200);
      expect(ok.body.can_manage_assignments).toBe(false);

      const calls = [
        ['get', `/api/admin/events/${eventId}/password`],
        ['post', `/api/admin/events/${eventId}/reset-password`],
        ['post', `/api/admin/events/${eventId}/resend-email`],
        ['post', `/api/admin/events/${eventId}/archive`],
        ['delete', `/api/admin/events/${eventId}`],
        ['delete', `/api/admin/archives/${eventId}`],
      ];
      for (const [verb, url] of calls) {
        // eslint-disable-next-line no-await-in-loop
        const res = await as(request(app)[verb](url), 'hand').send({});
        expect([verb, url, res.status]).toEqual([verb, url, 403]);
      }
      const bulk = await as(request(app).post('/api/admin/events/bulk-delete'), 'hand').send({ eventIds: [eventId] });
      expect(bulk.body.deleted ?? bulk.body.deletedCount ?? 0).toBeFalsy();
      expect(await db('events').where({ id: eventId }).first()).toBeTruthy();
    });

    it('keeps setting the gallery password and client PIN with the owner', async () => {
      const before = await db('events').where({ id: eventId }).first('password_hash', 'client_password_hash', 'client_share_token', 'require_password');
      const refused = [
        ['put', `/api/admin/events/${eventId}`, { password: 'hand-picked-1' }],
        ['put', `/api/admin/events/${eventId}`, { client_password: '654321' }],
        ['put', `/api/admin/events/${eventId}`, { regenerate_client_token: true }],
        ['put', `/api/admin/events/${eventId}`, { require_password: !before.require_password }],
        ['post', `/api/admin/events/${eventId}/publish`, { password: 'hand-picked-1' }],
        ['post', `/api/admin/events/${eventId}/send-gallery-email`, { password: 'hand-picked-1' }],
      ];
      for (const [verb, url, body] of refused) {
        // eslint-disable-next-line no-await-in-loop
        const res = await as(request(app)[verb](url), 'hand').send(body);
        expect([url, Object.keys(body)[0], res.status, res.body.code]).toEqual([url, Object.keys(body)[0], 403, 'EVENT_OWNER_REQUIRED']);
      }
      expect(await db('events').where({ id: eventId }).first('password_hash', 'client_password_hash', 'client_share_token', 'require_password'))
        .toEqual(before);

      // The rest of the update stays theirs, with the settings draft's echo
      // of require_password and its empty password fields.
      const edit = await as(request(app).put(`/api/admin/events/${eventId}`), 'hand')
        .send({ welcome_message: 'From the team', require_password: Boolean(before.require_password), password: '', client_password: '' });
      expect(edit.status).toBe(200);
      expect((await db('events').where({ id: eventId }).first()).welcome_message).toBe('From the team');

      const owner = await as(request(app).put(`/api/admin/events/${eventId}`), 'owner').send({ client_password: '654321' });
      expect(owner.status).toBe(200);
    });

    it('answers a non-owner 403 before saying which admin ids are live', async () => {
      const res = await as(request(app).put(`/api/admin/events/${eventId}`), 'hand')
        .send({ assigned_admin_ids: [id.hand, id.team, 987654] });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('EVENT_OWNER_REQUIRED');
    });

    it('lists super admins as assignable to a super admin only', async () => {
      const superRows = await db('admin_users').insert({
        username: 'team-root', email: 'team-root@example.com', password_hash: 'x', must_change_password: false, created_at: now(),
      }).returning('id');
      const rootId = superRows[0]?.id ?? superRows[0];
      await assignAdminRole(db, rootId, 'super_admin');
      tok.root = mintAdminToken(rootId);

      const names = async (who) => (await as(request(app).get('/api/admin/events/assignable-admins'), who)).body.admins.map((a) => a.username);
      expect(await names('owner')).not.toContain('team-root');
      expect(await names('root')).toContain('team-root');
    });

    it('does not let a held team member start a folder watcher', async () => {
      const res = await as(request(app).put(`/api/admin/events/${eventId}`), 'hand')
        .send({ source_mode: 'reference', external_path: 'somewhere', external_watch: true });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('UPLOAD_REVIEW_REQUIRED');
    });

    it('holds photo.uploaded until approval, and keeps a held photo\'s category from guests', async () => {
      const webhookService = require('../../src/services/webhookService');
      const fire = jest.spyOn(webhookService, 'fire').mockResolvedValue(undefined);
      try {
        const [catRow] = await db('photo_categories').insert({
          name: 'Backstage', slug: 'backstage', event_id: eventId, is_global: false, created_at: now(),
        }).returning('id');
        const catId = catRow?.id ?? catRow;

        const held = await as(request(app).post(`/api/admin/photos/${eventId}/upload`), 'hand')
          .field('category_id', String(catId))
          .attach('photos', jpeg, { filename: 'hand.jpg', contentType: 'image/jpeg' });
        expect(held.status).toBe(202);
        const heldId = held.body.photo_ids[0];
        await db('photos').where({ id: heldId }).update({ processing_status: 'complete', category_id: catId });
        expect(fire.mock.calls.filter(([type]) => type === 'photo.uploaded')).toHaveLength(0);

        const event = await db('events').where({ id: eventId }).first();
        for (const accessLevel of ['client', undefined]) {
          const token = jwt.sign(
            { eventId: event.id, eventSlug: event.slug, type: 'gallery', ...(accessLevel ? { accessLevel } : {}) },
            process.env.JWT_SECRET, { expiresIn: '1h', issuer: 'picpeak-auth' });
          // eslint-disable-next-line no-await-in-loop
          const res = await request(app).get(`/api/gallery/${event.slug}/photos`).set('Authorization', `Bearer ${token}`);
          expect(res.status).toBe(200);
          expect(JSON.stringify(res.body.categories || [])).not.toContain('Backstage');
        }

        const approve = await as(request(app).post(`/api/admin/photos/${eventId}/photos/moderation`), 'owner')
          .send({ photoIds: [heldId], action: 'approve' });
        expect(approve.status).toBe(200);
        const fired = fire.mock.calls.filter(([type]) => type === 'photo.uploaded');
        expect(fired).toHaveLength(1);
        expect(fired[0][1].photo.id).toBe(heldId);
      } finally {
        fire.mockRestore();
      }
    });
  });
});
