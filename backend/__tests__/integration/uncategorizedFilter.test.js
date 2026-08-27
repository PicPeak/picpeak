/**
 * The admin photo list's category filter, and the value it answers to (#1211).
 *
 * The frontend used to send `category_id=0` for "Uncategorized". This route
 * skips `'0'` outright — the guard reads `category_id !== '0'` — so no
 * condition was applied and the whole event came back. Four lines below that
 * guard sits the branch that does the work, keyed on the literal
 * `uncategorized`, which nothing was sending.
 *
 * Reported in #1209 by someone trying to isolate a few thousand uncategorised
 * imports. The frontend half is fixed in PhotoFilters; this pins the backend
 * half of the same contract, because the failure mode was the two ends
 * disagreeing about a string and neither one being wrong on its own.
 */

const request = require('supertest');
const express = require('express');

const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

describe('admin photo list — uncategorized filter (#1211)', () => {
  let db; let cleanup; let app;
  let eventId; let categoryId;
  let uncategorisedIds; let categorisedId;

  const list = async (query = '') => {
    const res = await request(app).get(`/api/admin/events/${eventId}/photos${query}`);
    expect(res.status).toBe(200);
    const photos = Array.isArray(res.body) ? res.body : res.body.photos;
    return (photos || []).map((p) => p.id).sort((a, b) => a - b);
  };

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

    const [ev] = await db('events').insert({
      slug: 'uncat-filter', event_type: 'wedding', event_name: 'Uncat Filter',
      event_date: '2026-08-01', host_email: 'h@example.com', admin_email: 'a@example.com',
      password_hash: 'x', share_link: '/gallery/uncat-filter/share',
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      is_active: 1, is_archived: 0, is_draft: 0, created_at: new Date().toISOString(),
    }).returning('id');
    eventId = typeof ev === 'object' ? ev.id : ev;

    const [cat] = await db('photo_categories')
      .insert({ name: 'Ceremony', slug: 'ceremony', event_id: eventId })
      .returning('id');
    categoryId = typeof cat === 'object' ? cat.id : cat;

    const insertPhoto = async (filename, category) => {
      const [p] = await db('photos').insert({
        event_id: eventId, filename, path: `events/uncat/${filename}`,
        type: 'individual', category_id: category,
        uploaded_at: new Date().toISOString(),
      }).returning('id');
      return typeof p === 'object' ? p.id : p;
    };

    // Two with no category — the shape a plugin upload leaves behind — and one
    // filed properly, so a filter that does nothing is visibly different from
    // a filter that works.
    uncategorisedIds = [await insertPhoto('a.jpg', null), await insertPhoto('b.jpg', null)];
    categorisedId = await insertPhoto('c.jpg', categoryId);
    uncategorisedIds.sort((a, b) => a - b);

    app = express();
    app.use(express.json());
    app.use('/api/admin/events', require('../../src/routes/adminPhotos'));
  }, 180000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  it('returns only the photos with no category', async () => {
    expect(await list('?category_id=uncategorized')).toEqual(uncategorisedIds);
  });

  it('returns everything when no category filter is given', async () => {
    expect(await list()).toEqual([...uncategorisedIds, categorisedId].sort((a, b) => a - b));
  });

  it('still filters by a real category id', async () => {
    expect(await list(`?category_id=${categoryId}`)).toEqual([categorisedId]);
  });

  it('treats 0 as no filter at all', async () => {
    // Pinning the behaviour that made the bug silent rather than loud: '0' is
    // not "uncategorized" and never was, it simply falls through the guard. A
    // future change that made 0 mean uncategorized here would be fine too —
    // but it must be a decision, not an accident, and this test forces it.
    expect(await list('?category_id=0')).toEqual([...uncategorisedIds, categorisedId].sort((a, b) => a - b));
  });
});
