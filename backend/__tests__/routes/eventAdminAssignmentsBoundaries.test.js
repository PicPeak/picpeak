/**
 * Boundaries of gallery team members and upload review (issue 743,
 * migration 269), next to eventAdminAssignments.test.js.
 *
 * One group per surface the review asked to pin:
 *  1. a photo under review is out of reach of every gallery viewer, the PIN
 *     client included, on the media routes, the single and ZIP downloads,
 *     the download jobs, the slideshow and the people strip
 *  2. the chunked and v1 uploads hold a team member's photo like the batch
 *     route does, and v1 refuses a team member's replaces_photo_id
 *  3. moderation only moves photos of the event in the URL
 *  4. transfers and projects stay with the owner: an assignment to a gallery
 *     hands over neither
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-team-bounds-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'team-bounds-test-secret';
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-team-bounds-storage-'));

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const sharp = require('sharp');
const { bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken } = require('../integration/helpers/crmDb');
const { generateApiToken } = require('../../src/middleware/apiTokenAuth');

jest.setTimeout(120000);

const SLUG = 'team-bounds';
const SHOW_LINK = 'd'.repeat(64);
const VISIBLE_NAME = 'visible-shot.jpg';
const HELD_NAME = 'held-shot.jpg';

// Collects a binary body (ZIP) into a Buffer.
const binary = (res, cb) => {
  const chunks = [];
  res.on('data', (c) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

describe('gallery team members and upload review: boundaries (issue 743)', () => {
  let db; let cleanup; let app; let jpeg;
  const tok = {};
  const id = {};

  const as = (req, who) => req.set('Authorization', `Bearer ${tok[who]}`);
  const now = () => new Date().toISOString();
  const unwrap = (rows) => rows[0]?.id ?? rows[0];

  async function mkAdmin(name, roleName) {
    const adminId = unwrap(await db('admin_users').insert({
      username: `bounds-${name}`,
      email: `bounds-${name}@example.com`,
      password_hash: 'x',
      must_change_password: false,
      created_at: now(),
    }).returning('id'));
    await assignAdminRole(db, adminId, roleName);
    tok[name] = mintAdminToken(adminId);
    return adminId;
  }

  async function mkEvent(slug, createdBy, extra = {}) {
    const eventId = unwrap(await db('events').insert({
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
      allow_downloads: 1,
      created_at: now(),
      ...extra,
    }).returning('id'));
    await fs.promises.mkdir(path.join(process.env.STORAGE_PATH, 'events', 'active', slug), { recursive: true });
    return eventId;
  }

  async function mkPhoto(eventId, slug, filename, columns = {}) {
    fs.writeFileSync(path.join(process.env.STORAGE_PATH, 'events', 'active', slug, filename), jpeg);
    return unwrap(await db('photos').insert({
      event_id: eventId,
      filename,
      original_filename: filename,
      path: `${slug}/${filename}`,
      type: 'individual',
      media_type: 'image',
      mime_type: 'image/jpeg',
      visibility: 'visible',
      uploaded_at: now(),
      ...columns,
    }).returning('id'));
  }

  async function mkApiToken(adminId) {
    const { plaintext, hashed } = generateApiToken();
    await db('api_tokens').insert({
      name: `bounds-${adminId}`, hashed_token: hashed, scopes: 'write', created_by: adminId, created_at: now(),
    });
    return plaintext;
  }

  async function setFlag(key) {
    await db('feature_flags').where({ key }).del();
    await db('feature_flags').insert({ key, value: true });
  }

  const galleryToken = (accessLevel) => jwt.sign(
    { eventId: id.event, eventSlug: SLUG, type: 'gallery', ...(accessLevel ? { accessLevel } : {}) },
    process.env.JWT_SECRET, { expiresIn: '1h', issuer: 'picpeak-auth' },
  );
  const VIEWERS = [['PIN client', 'client'], ['guest', undefined]];
  const gallery = (method, url, token) => request(app)[method](`/api/gallery/${SLUG}${url}`)
    .set('Authorization', `Bearer ${token}`).redirects(0);

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);
    jpeg = await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 200, g: 80, b: 30 } } })
      .jpeg().toBuffer();

    await setFlag('slideshow');
    await setFlag('faces');
    await setFlag('transfers');
    await setFlag('projects');
    require('../../src/middleware/requireFeatureFlag').invalidateFeatureFlagCache();

    id.owner = await mkAdmin('owner', 'editor');
    id.team = await mkAdmin('team', 'team_photographer');
    id.editorMember = await mkAdmin('editor-member', 'editor');
    id.otherOwner = await mkAdmin('other-owner', 'editor');

    id.event = await mkEvent(SLUG, id.owner, {
      review_contributor_uploads: true,
      show_share_token: SHOW_LINK,
      face_recognition_enabled: true,
      faces_visible_to_guests: true,
      download_resolution_picker_enabled: true,
    });
    id.secondEvent = await mkEvent('team-bounds-second', id.owner);
    id.foreignEvent = await mkEvent('team-bounds-foreign', id.otherOwner, { review_contributor_uploads: true });
    await db('event_admin_assignments').insert([
      { event_id: id.event, admin_user_id: id.team, assigned_by: id.owner },
      { event_id: id.event, admin_user_id: id.editorMember, assigned_by: id.owner },
      { event_id: id.secondEvent, admin_user_id: id.editorMember, assigned_by: id.owner },
    ]);

    id.visible = await mkPhoto(id.event, SLUG, VISIBLE_NAME, { face_status: 'done' });
    id.held = await mkPhoto(id.event, SLUG, HELD_NAME, {
      visibility: 'hidden', moderation_status: 'pending', uploaded_by_admin_id: id.team, face_status: 'done',
    });

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/admin/photos', require('../../src/routes/adminPhotos'));
    app.use('/api/admin/transfers', require('../../src/routes/adminTransfers'));
    app.use('/api/admin/projects', require('../../src/routes/adminProjects'));
    app.use('/api/gallery', require('../../src/routes/gallery'));
    app.use('/api/v1', require('../../src/routes/v1/events'));
    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => {
      res.status(err.statusCode || err.status || 500).json({ error: err.message, code: err.code });
    });
  }, 180000);

  afterAll(async () => {
    // Let a download job still building finish before the database goes.
    const jobs = require('../../src/services/downloadJobService');
    await Promise.allSettled([...(jobs.liveBuilds?.values?.() || [])]);
    require('../../src/services/chunkedUploadService').stop();
    if (cleanup) await cleanup();
  });

  // ── 1 ────────────────────────────────────────────────────────────────────
  // Pins isPhotoHiddenFromViewer's moderation_status check (utils/
  // photoVisibility.js) as used by the media and single-download routes, and
  // applyPhotoVisibilityFilter's whereNull('photos.moderation_status') for the
  // client, which the ZIP routes and downloadJobService.photoQuery run. A
  // guest is refused on visibility already; the PIN client is the case only
  // the review guard covers.
  describe('a photo under review, for gallery viewers', () => {
    it.each(VIEWERS)('is refused on thumbnail, preview, original, view beacon and single download for a %s', async (_label, level) => {
      const token = galleryToken(level);
      const routes = [
        ['get', 'thumbnail'], ['get', 'preview'], ['get', 'photo'], ['get', 'download'],
      ];
      for (const [method, route] of routes) {
        const shown = await gallery(method, `/${route}/${id.visible}`, token);
        expect([`${route}: ${shown.status}`]).toEqual([`${route}: 200`]);
        const held = await gallery(method, `/${route}/${id.held}`, token);
        expect([`${route}: ${held.status}`]).toEqual([`${route}: 403`]);
      }
      expect((await gallery('post', `/photo/${id.visible}/view`, token)).status).toBe(204);
      expect((await gallery('post', `/photo/${id.held}/view`, token)).status).toBe(403);
    });

    it.each(VIEWERS)('is left out of download-selected and download-all for a %s', async (_label, level) => {
      const token = galleryToken(level);
      const solo = await gallery('post', '/download-selected', token).send({ photo_ids: [id.held] });
      expect(solo.status).toBe(404);

      const both = await gallery('post', '/download-selected', token)
        .send({ photo_ids: [id.visible, id.held] }).buffer(true).parse(binary);
      expect(both.status).toBe(200);
      expect(both.body.includes(VISIBLE_NAME)).toBe(true);
      expect(both.body.includes(HELD_NAME)).toBe(false);

      const all = await gallery('get', '/download-all', token).buffer(true).parse(binary);
      expect(all.status).toBe(200);
      expect(all.body.includes(VISIBLE_NAME)).toBe(true);
      expect(all.body.includes(HELD_NAME)).toBe(false);
    });

    it.each(VIEWERS)('is not packed into a download job for a %s', async (_label, level) => {
      const token = galleryToken(level);
      const solo = await gallery('post', '/download-jobs', token).send({ photo_ids: [id.held] });
      expect(solo.status).toBe(404);

      const both = await gallery('post', '/download-jobs', token).send({ photo_ids: [id.visible, id.held] });
      expect(both.status).toBe(202);
      const job = await db('download_jobs').where({ token: both.body.token }).first();
      expect(JSON.parse(job.photo_ids).map(Number)).toEqual([id.visible]);

      // Let the build settle so it does not outlive the suite.
      const deadline = Date.now() + 15000;
      let row = job;
      while (['pending', 'building'].includes(row.status) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
        row = await db('download_jobs').where({ id: job.id }).first();
      }
    });

    it('is out of the slideshow: count, list and media', async () => {
      const session = await request(app).get(`/api/gallery/${SLUG}/show/${SHOW_LINK}/session`);
      expect(session.status).toBe(200);
      expect(session.body.photo_count).toBe(1);

      const list = await gallery('get', '/photos', session.body.token);
      expect(list.status).toBe(200);
      const ids = list.body.photos.map((p) => p.id);
      expect(ids).toEqual([id.visible]);
      expect((await gallery('get', `/thumbnail/${id.held}`, session.body.token)).status).toBe(403);
    });

    it('does not show a person seen only in it, nor count it in the scan, for the PIN client', async () => {
      // Floor of one photo, so the person would show from the held photo alone.
      await db('app_settings').where({ setting_key: 'face_min_cluster_size' }).del();
      await db('app_settings').insert({
        setting_key: 'face_min_cluster_size', setting_value: JSON.stringify(1), setting_type: 'faces', updated_at: now(),
      });
      const personInVisible = unwrap(await db('event_people').insert({ event_id: id.event, face_count_total: 1 }).returning('id'));
      const personInHeld = unwrap(await db('event_people').insert({ event_id: id.event, face_count_total: 1 }).returning('id'));
      const face = (photoId, personId) => ({
        photo_id: photoId, event_id: id.event, person_id: personId,
        bbox_x: 1, bbox_y: 1, bbox_w: 10, bbox_h: 10, det_score: 0.9,
      });
      await db('photo_faces').insert([face(id.visible, personInVisible), face(id.held, personInHeld)]);

      for (const [label, level] of VIEWERS) {
        const res = await gallery('get', '/people', galleryToken(level));
        expect([label, res.status]).toEqual([label, 200]);
        expect([label, res.body.people.map((p) => p.id)]).toEqual([label, [personInVisible]]);
        expect([label, res.body.scan.total]).toEqual([label, 1]);
      }
    });
  });

  // ── 2 ────────────────────────────────────────────────────────────────────
  // Pins adminUploadColumns on the chunked complete route (adminPhotos.js) and
  // on the v1 insert (routes/v1/events.js), and the holdsForReview refusal of
  // replaces_photo_id on v1.
  describe('uploads by a team member under review, outside the batch route', () => {
    it('holds a chunked upload hidden + pending', async () => {
      const init = await as(request(app).post(`/api/admin/photos/${id.event}/chunked-upload/init`), 'team')
        .send({ filename: 'chunked-team.jpg', fileSize: jpeg.length, totalChunks: 1 });
      expect(init.status).toBe(200);
      const { uploadId } = init.body;
      const chunk = await as(request(app).post(`/api/admin/photos/${id.event}/chunked-upload/${uploadId}/chunk/0`), 'team')
        .set('Content-Type', 'application/octet-stream').send(jpeg);
      expect(chunk.status).toBe(200);
      const done = await as(request(app).post(`/api/admin/photos/${id.event}/chunked-upload/${uploadId}/complete`), 'team')
        .send({});
      expect(done.status).toBe(200);
      expect(done.body.uploaded).toBe(1);

      const row = await db('photos').where({ event_id: id.event, original_filename: 'chunked-team.jpg' }).first();
      expect(row).toMatchObject({ visibility: 'hidden', moderation_status: 'pending', uploaded_by_admin_id: id.team });
    });

    it('holds a v1 upload hidden + pending, and leaves the owner\'s alone', async () => {
      const teamApi = await mkApiToken(id.team);
      const res = await request(app).post(`/api/v1/events/${id.event}/photos`)
        .set('Authorization', `Bearer ${teamApi}`)
        .attach('photo', jpeg, { filename: 'v1-team.jpg', contentType: 'image/jpeg' });
      expect(res.status).toBe(201);
      expect(await db('photos').where({ id: res.body.id }).first())
        .toMatchObject({ visibility: 'hidden', moderation_status: 'pending', uploaded_by_admin_id: id.team });

      const ownerApi = await mkApiToken(id.owner);
      const own = await request(app).post(`/api/v1/events/${id.event}/photos`)
        .set('Authorization', `Bearer ${ownerApi}`)
        .attach('photo', jpeg, { filename: 'v1-owner.jpg', contentType: 'image/jpeg' });
      expect(own.status).toBe(201);
      expect((await db('photos').where({ id: own.body.id }).first()).moderation_status).toBeNull();
    });

    it('refuses a v1 replaces_photo_id from a team member under review', async () => {
      const teamApi = await mkApiToken(id.team);
      const before = await db('photos').where({ id: id.visible }).first();
      const res = await request(app).post(`/api/v1/events/${id.event}/photos`)
        .set('Authorization', `Bearer ${teamApi}`)
        .field('replaces_photo_id', String(id.visible))
        .attach('photo', jpeg, { filename: 'v1-replace.jpg', contentType: 'image/jpeg' });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('UPLOAD_REVIEW_REQUIRED');
      const after = await db('photos').where({ id: id.visible }).first();
      expect(after.original_filename).toBe(before.original_filename);
      expect(after.filename).toBe(before.filename);
      expect(await db('photos').where({ original_filename: 'v1-replace.jpg' }).first()).toBeUndefined();
    });
  });

  // ── 3 ────────────────────────────────────────────────────────────────────
  // Pins moderatePhotos' where('event_id', eventId) (uploadReviewService.js):
  // the route checks the caller against the URL's event only.
  describe('moderation across events', () => {
    it('does not move photos of another event, for the owner of the URL\'s event', async () => {
      const foreignHeld = await mkPhoto(id.foreignEvent, 'team-bounds-foreign', 'foreign-held.jpg', {
        visibility: 'hidden', moderation_status: 'pending',
      });
      const ownHeldElsewhere = await mkPhoto(id.secondEvent, 'team-bounds-second', 'second-held.jpg', {
        visibility: 'hidden', moderation_status: 'pending',
      });

      for (const action of ['approve', 'reject']) {
        const res = await as(request(app).post(`/api/admin/photos/${id.event}/photos/moderation`), 'owner')
          .send({ photoIds: [foreignHeld, ownHeldElsewhere], action });
        expect(res.status).toBe(200);
        expect(res.body.updated).toBe(0);
      }
      for (const photoId of [foreignHeld, ownHeldElsewhere]) {
        expect(await db('photos').where({ id: photoId }).first())
          .toMatchObject({ visibility: 'hidden', moderation_status: 'pending' });
      }
    });
  });

  // ── 4 ────────────────────────────────────────────────────────────────────
  // Pins requireTransferOwnership + listTransfers' created_by scope, and
  // addFiles' filterOwnedPhotoIds -> filterOwnedEventIds without
  // honourManageAll (transferService.js); ownedProjectsSubquery's created_by
  // and linked-event rules, and the owner-only filterOwnedEventIds on
  // POST /projects/:id/events (adminProjects.js). The assigned editor holds
  // events.view + events.edit, so only ownership stands in the way.
  describe('transfers and projects stay with the owner', () => {
    let ownerTransfer; let memberTransfer;
    let ownerProject; let ownerlessProject; let memberProject;

    const mkTransfer = async (createdBy, title) => unwrap(await db('transfers').insert({
      token: require('crypto').randomBytes(32).toString('hex'),
      kind: 'send',
      title,
      created_by: createdBy,
      expires_at: new Date(Date.now() + 14 * 864e5).toISOString(),
      download_count: 0,
      is_active: true,
      grace_days: 7,
      allow_uploads: false,
      delivery_method: 'link',
      created_at: now(),
      updated_at: now(),
    }).returning('id'));

    const mkProject = async (name, createdBy) => unwrap(await db('projects').insert({
      name, status: 'active', created_by: createdBy, created_at: now(), updated_at: now(),
    }).returning('id'));

    beforeAll(async () => {
      ownerTransfer = await mkTransfer(id.owner, 'owner transfer');
      await db('transfer_files').insert({ transfer_id: ownerTransfer, photo_id: id.visible, sort_order: 1, created_at: now() });
      memberTransfer = await mkTransfer(id.editorMember, 'member transfer');

      ownerProject = await mkProject('owner project', id.owner);
      await db('events').where({ id: id.event }).update({ project_id: ownerProject });
      ownerlessProject = await mkProject('ownerless project', null);
      await db('events').where({ id: id.secondEvent }).update({ project_id: ownerlessProject });
      memberProject = await mkProject('member project', id.editorMember);
    });

    it('starts from an assignment that reaches the gallery, without a role that reaches every gallery', async () => {
      expect((await as(request(app).get(`/api/admin/photos/${id.event}/photos`), 'editor-member')).status).toBe(200);
      expect((await as(request(app).get(`/api/admin/photos/${id.secondEvent}/photos`), 'editor-member')).status).toBe(200);
      const scopePerms = await db('role_permissions')
        .join('roles', 'roles.id', 'role_permissions.role_id')
        .join('permissions', 'permissions.id', 'role_permissions.permission_id')
        .where('roles.name', 'editor')
        .whereIn('permissions.name', ['events.manage_all', 'events.edit'])
        .pluck('permissions.name');
      expect(scopePerms).toEqual(['events.edit']);
    });

    it('keeps the owner\'s transfer of the assigned gallery\'s photos from the team member', async () => {
      const list = await as(request(app).get('/api/admin/transfers'), 'editor-member');
      expect(list.status).toBe(200);
      const listed = (list.body.transfers || list.body.data?.transfers || []).map((t) => t.id);
      expect(listed).toContain(memberTransfer);
      expect(listed).not.toContain(ownerTransfer);

      expect((await as(request(app).get(`/api/admin/transfers/${ownerTransfer}`), 'editor-member')).status).toBe(404);
      expect((await as(request(app).get(`/api/admin/transfers/${ownerTransfer}/download`), 'editor-member')).status).toBe(404);
      const add = await as(request(app).post(`/api/admin/transfers/${ownerTransfer}/files`), 'editor-member')
        .send({ photoIds: [id.visible] });
      expect(add.status).toBe(404);

      // The owner reaches it: the 404 above is ownership, not a broken route.
      expect((await as(request(app).get(`/api/admin/transfers/${ownerTransfer}`), 'owner')).status).toBe(200);
    });

    it('does not let the team member bundle the assigned gallery\'s photos into a transfer of its own', async () => {
      const res = await as(request(app).post(`/api/admin/transfers/${memberTransfer}/files`), 'editor-member')
        .send({ photoIds: [id.visible] });
      expect(res.status).toBe(200);
      expect(await db('transfer_files').where({ transfer_id: memberTransfer })).toEqual([]);
    });

    it('keeps the owner\'s and the ownerless project of the assigned galleries from the team member', async () => {
      const list = await as(request(app).get('/api/admin/projects'), 'editor-member');
      expect(list.status).toBe(200);
      const listed = (list.body.projects || list.body.data?.projects || []).map((p) => p.id);
      expect(listed).toContain(memberProject);
      expect(listed).not.toContain(ownerProject);
      expect(listed).not.toContain(ownerlessProject);

      for (const projectId of [ownerProject, ownerlessProject]) {
        expect((await as(request(app).get(`/api/admin/projects/${projectId}`), 'editor-member')).status).toBe(404);
        expect((await as(request(app).get(`/api/admin/projects/${projectId}/overview`), 'editor-member')).status).toBe(404);
        const rename = await as(request(app).put(`/api/admin/projects/${projectId}`), 'editor-member').send({ name: 'taken' });
        expect(rename.status).toBe(404);
        // The owner reaches both.
        expect((await as(request(app).get(`/api/admin/projects/${projectId}`), 'owner')).status).toBe(200);
      }
    });

    it('does not let the team member pull the assigned gallery into a project of its own', async () => {
      const res = await as(request(app).post(`/api/admin/projects/${memberProject}/events`), 'editor-member')
        .send({ eventId: id.event });
      expect(res.status).toBe(403);
      expect(Number((await db('events').where({ id: id.event }).first()).project_id)).toBe(ownerProject);
    });
  });
});
