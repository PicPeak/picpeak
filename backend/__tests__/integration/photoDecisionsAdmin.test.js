/**
 * Approve / reject per photo (issue 744), from the photographer's side: the
 * admin list filter and counts, the filter summary, the export columns, the
 * guest merge, and migration 270 itself.
 */

const request = require('supertest');
const express = require('express');

const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

describe('approve / reject per photo — admin side (issue 744)', () => {
  let db; let cleanup; let app; let feedbackService; let PhotoFilterBuilder; let PhotoExportService;
  let eventId; let approvedId; let rejectedId; let bothId; let undecidedId; let guests;

  const list = async (query = '') => {
    const res = await request(app).get(`/api/admin/events/${eventId}/photos${query}`);
    expect(res.status).toBe(200);
    return res.body.photos;
  };
  const ids = (photos) => photos.map((p) => p.id).sort((a, b) => a - b);
  const sorted = (...values) => values.sort((a, b) => a - b);

  const decide = (photoId, guest, decision, reason) => feedbackService.submitFeedback(
    photoId, eventId,
    { feedback_type: 'decision', decision, comment_text: reason, guest_name: guest.name, guest_id: guest.id },
    guest.identifier,
  );

  beforeAll(async () => {
    jest.resetModules();
    jest.doMock('../../src/middleware/auth', () => ({
      adminAuth: (req, _res, next) => { req.admin = { id: 1, username: 'tester' }; next(); },
    }));
    jest.doMock('../../src/middleware/permissions', () => ({
      requirePermission: () => (_req, _res, next) => next(),
    }));
    jest.doMock('../../src/middleware/ownership', () => ({
      requireEventOwnership: (_req, _res, next) => next(),
    }));
    jest.doMock('../../src/utils/logger', () => ({
      debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(),
    }));

    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);
    feedbackService = require('../../src/services/feedbackService');
    ({ PhotoFilterBuilder } = require('../../src/utils/photoFilterBuilder'));
    ({ PhotoExportService } = require('../../src/services/photoExportService'));

    const [ev] = await db('events').insert({
      slug: 'decisions-admin', event_type: 'wedding', event_name: 'Decisions Admin',
      event_date: '2026-08-01', host_email: 'h@example.com', admin_email: 'a@example.com',
      password_hash: 'x', share_link: '/gallery/decisions-admin/share',
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      is_active: 1, is_archived: 0, is_draft: 0, created_at: new Date().toISOString(),
    }).returning('id');
    eventId = typeof ev === 'object' ? ev.id : ev;
    await db('event_feedback_settings').insert({
      event_id: eventId, feedback_enabled: true, allow_decisions: true, identity_mode: 'guest',
    });

    const insertPhoto = async (filename) => {
      const [p] = await db('photos').insert({
        event_id: eventId, filename, path: `events/decisions-admin/${filename}`,
        type: 'individual', uploaded_at: new Date().toISOString(),
      }).returning('id');
      return typeof p === 'object' ? p.id : p;
    };
    approvedId = await insertPhoto('approved.jpg');
    rejectedId = await insertPhoto('rejected.jpg');
    bothId = await insertPhoto('both.jpg');
    undecidedId = await insertPhoto('undecided.jpg');

    guests = await db('gallery_guests').insert(['Anna', 'Ben'].map((name) => ({
      event_id: eventId, name, identifier: `guest-${name}`, email: `${name}@example.com`, is_deleted: false,
    }))).returning('*');

    await decide(approvedId, guests[0], 'approved');
    await decide(rejectedId, guests[0], 'rejected', 'Eyes closed');
    await decide(bothId, guests[0], 'approved');
    await decide(bothId, guests[1], 'rejected', '=HYPERLINK("x")');

    app = express();
    app.use(express.json());
    app.use('/api/admin/events', require('../../src/routes/adminPhotos'));
  }, 180000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  it('carries the tallies on every photo of the admin list', async () => {
    const byId = Object.fromEntries((await list()).map((p) => [p.id, p]));
    expect(byId[approvedId]).toMatchObject({ approved_count: 1, rejected_count: 0 });
    expect(byId[bothId]).toMatchObject({ approved_count: 1, rejected_count: 1 });
    expect(byId[undecidedId]).toMatchObject({ approved_count: 0, rejected_count: 0 });
  });

  it('filters the admin list by approved, rejected and undecided', async () => {
    expect(ids(await list('?decision=approved'))).toEqual(sorted(approvedId, bothId));
    expect(ids(await list('?decision=rejected'))).toEqual(sorted(rejectedId, bothId));
    expect(ids(await list('?decision=undecided'))).toEqual([undecidedId]);
    // Several values OR among themselves, as one condition beside the others.
    expect(ids(await list('?decision=approved,undecided&has_likes=false'))).toEqual(sorted(approvedId, bothId, undecidedId));
    // Unknown values are dropped, not passed on.
    expect(ids(await list('?decision=maybe'))).toHaveLength(4);
  });

  it('filters the export selection and counts the summary the same way', async () => {
    const builder = new PhotoFilterBuilder(db('photos').select('photos.id'), eventId);
    builder.applyFilters({ decisions: ['rejected'] });
    expect(ids(await builder.getQuery())).toEqual(sorted(rejectedId, bothId));

    const summary = await PhotoFilterBuilder.getSummary(db, eventId);
    expect(summary).toMatchObject({ total: 4, withApproved: 2, withRejected: 2, withDecisions: 3 });
  });

  it('puts the decision and its reason in both feedback exports', async () => {
    const long = await feedbackService.exportEventFeedback(eventId);
    expect(long).toEqual(expect.arrayContaining([
      expect.objectContaining({ filename: 'rejected.jpg', feedback_type: 'decision', decision: 'rejected', comment_text: 'Eyes closed' }),
    ]));

    const pivot = await feedbackService.exportEventFeedbackPivoted(eventId);
    expect(pivot).toEqual(expect.arrayContaining([
      expect.objectContaining({ filename: 'rejected.jpg', decision: 'rejected', decision_reason: 'Eyes closed', comment: '' }),
      expect.objectContaining({ filename: 'approved.jpg', decision: 'approved', decision_reason: '' }),
    ]));

    const summary = await feedbackService.getEventFeedbackSummary(eventId);
    expect(Number(summary.stats.total_approved)).toBe(2);
    expect(Number(summary.stats.total_rejected)).toBe(2);
  });

  it('appends approved / rejected to the photo CSV and JSON exports', async () => {
    const service = new PhotoExportService();
    const csv = await service.exportPhotos(eventId, [bothId], 'csv');
    const [header, row] = csv.content.split('\n');
    expect(header.split(',').slice(-2)).toEqual(['approved', 'rejected']);
    expect(row.split(',').slice(-2)).toEqual(['"1"', '"1"']);

    const json = JSON.parse((await service.exportPhotos(eventId, [rejectedId], 'json')).content);
    expect(json.photos[0].decisions).toEqual({ approved: 0, rejected: 1 });
  });

  it('carries decisions through a guest merge, latest one winning', async () => {
    const photoId = undecidedId;
    await db('photo_feedback').insert([
      { event_id: eventId, photo_id: photoId, guest_id: guests[0].id, guest_identifier: guests[0].identifier,
        feedback_type: 'decision', decision: 'approved', is_hidden: false, is_approved: true,
        created_at: '2026-09-15T10:00:00.000Z', updated_at: '2026-09-15T10:00:00.000Z' },
      { event_id: eventId, photo_id: photoId, guest_id: guests[1].id, guest_identifier: guests[1].identifier,
        feedback_type: 'decision', decision: 'rejected', comment_text: 'Later thought', is_hidden: false, is_approved: true,
        created_at: '2026-09-15T11:00:00.000Z', updated_at: '2026-09-15T11:00:00.000Z' },
    ]);

    await feedbackService.mergeGuestFeedback(guests[0].id, [guests[1].id]);

    const rows = await db('photo_feedback').where({ photo_id: photoId, feedback_type: 'decision' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ guest_id: guests[0].id, decision: 'rejected', comment_text: 'Later thought' });
    expect(await db('photos').where({ id: photoId }).first('approved_count', 'rejected_count'))
      .toMatchObject({ approved_count: 0, rejected_count: 1 });
  });

  it('migration 270 is re-runnable and reversible', async () => {
    const mig = require('../../migrations/core/270_photo_feedback_decisions');
    await mig.up(db);
    await mig.down(db);
    expect(await db.schema.hasColumn('photo_feedback', 'decision')).toBe(false);
    expect(await db.schema.hasColumn('photos', 'approved_count')).toBe(false);
    expect(await db.schema.hasColumn('event_feedback_settings', 'allow_decisions')).toBe(false);
    await mig.up(db);
    await mig.up(db);
    expect(await db.schema.hasColumn('photo_feedback', 'decision')).toBe(true);
    expect(await db.schema.hasColumn('photos', 'rejected_count')).toBe(true);
    expect(await db.schema.hasColumn('event_feedback_settings', 'allow_decisions')).toBe(true);
  });
});
