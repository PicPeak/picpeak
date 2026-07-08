/**
 * Regression test for the cross-event thumbnail enumeration leak.
 *
 * Thumbnails are served flat from /thumbnails/thumb_<name> with
 * deterministic, enumerable filenames. photoAuth previously granted any
 * holder of a gallery token for ANY active event access to ANY thumbnail
 * (it set eventSlug=null and returned next() as long as the token's event
 * existed), so a visitor to one gallery could pull another (password-
 * protected) gallery's entire thumbnail set. The fix scopes thumbnail
 * access to the token's event by matching the requested file against
 * photos.thumbnail_path for that event_id.
 */

process.env.JWT_SECRET = 'test-secret-thumbnail-scope-000000000000';

const jwt = require('jsonwebtoken');

// Two events, each owning one thumbnail. The photos mock resolves a row
// only when BOTH event_id and thumbnail_path match — i.e. it models the
// real ownership query.
const EVENTS = [
  { id: 10, slug: 'event-a', is_active: 1 },
  { id: 20, slug: 'event-b', is_active: 1 },
];
const PHOTOS = [
  { id: 1, event_id: 10, thumbnail_path: 'thumbnails/thumb_event-a_ceremony_0001.jpg' },
  { id: 2, event_id: 20, thumbnail_path: 'thumbnails/thumb_event-b_ceremony_0001.jpg' },
];

jest.mock('../../src/database/db', () => ({
  db: (table) => ({
    _cond: null,
    where(cond) { this._cond = cond; return this; },
    first() {
      if (table === 'events') {
        return Promise.resolve(EVENTS.find((e) => e.id === this._cond.id) || null);
      }
      if (table === 'photos') {
        return Promise.resolve(
          PHOTOS.find((p) => p.event_id === this._cond.event_id
            && p.thumbnail_path === this._cond.thumbnail_path) || null
        );
      }
      return Promise.resolve(null);
    },
  }),
}));

jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const photoAuth = require('../../src/middleware/photoAuth');

function galleryToken(eventId) {
  return jwt.sign({ type: 'gallery', eventId }, process.env.JWT_SECRET, { issuer: 'picpeak-auth' });
}

function makeReqRes(token, thumbPath) {
  const req = { path: thumbPath, headers: { authorization: `Bearer ${token}` }, cookies: {} };
  const res = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return { req, res };
}

describe('photoAuth — thumbnail ownership scoping', () => {
  it('denies a gallery token for event A fetching event B\'s thumbnail', async () => {
    const { req, res } = makeReqRes(galleryToken(10), '/thumb_event-b_ceremony_0001.jpg');
    const next = jest.fn();

    await photoAuth(req, res, next);

    // Access denied: middleware must not pass the request through.
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(req.event).toBeUndefined();
  });

  it('allows a gallery token to fetch its own event\'s thumbnail', async () => {
    const { req, res } = makeReqRes(galleryToken(20), '/thumb_event-b_ceremony_0001.jpg');
    const next = jest.fn();

    await photoAuth(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.event).toMatchObject({ id: 20 });
  });

  it('denies a traversal / foreign filename that matches no owned thumbnail', async () => {
    const { req, res } = makeReqRes(galleryToken(10), '/thumb_../../etc/passwd');
    const next = jest.fn();

    await photoAuth(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(req.event).toBeUndefined();
  });
});
