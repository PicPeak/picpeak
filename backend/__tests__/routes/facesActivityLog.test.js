/**
 * Face-recognition activity log entries must carry their gallery and actor
 * (issue 1978).
 *
 * logActivity is positional — (activityType, metadata, eventId, actor). The
 * faces routes used to pack actorType/actorId/eventId into the metadata
 * object, so every entry was written with no event_id and actor_type
 * 'system': missing from the gallery's activity and attributed to nobody.
 */

const request = require('supertest');
const express = require('express');

const EVENT = { id: 42, face_recognition_enabled: false };
const ADMIN = { id: 7, username: 'face-admin' };

const mockLogActivity = jest.fn(() => Promise.resolve());

// Minimal chainable knex stand-in: every builder method returns the builder,
// and awaiting it (or .first()) resolves to nothing.
function mockBuilder() {
  const b = {};
  for (const m of ['where', 'update', 'insert']) b[m] = jest.fn(() => b);
  b.first = jest.fn(() => Promise.resolve(undefined));
  b.then = (resolve) => resolve(1);
  return b;
}

jest.mock('../../src/database/db', () => ({
  db: jest.fn(() => mockBuilder()),
  logActivity: (...args) => mockLogActivity(...args),
}));
jest.mock('../../src/middleware/auth', () => ({
  adminAuth: (req, _res, next) => { req.admin = { id: 7, username: 'face-admin' }; next(); },
}));
jest.mock('../../src/middleware/permissions', () => ({
  requirePermission: () => (_req, _res, next) => next(),
}));
jest.mock('../../src/middleware/requireFeatureFlag', () => ({
  requireFeatureFlag: () => (_req, _res, next) => next(),
}));
jest.mock('../../src/middleware/ownership', () => ({
  requireEventOwnership: (_req, _res, next) => next(),
  scopeEventsQuery: () => ({ first: () => Promise.resolve({ id: 42, face_recognition_enabled: false }) }),
}));
jest.mock('../../src/services/faceSettings', () => ({
  isEnabledForEvent: jest.fn(() => Promise.resolve(true)),
}));
jest.mock('../../src/services/faceProcessor', () => ({
  enqueueEvent: jest.fn(() => Promise.resolve(3)),
  purgeEvent: jest.fn(() => Promise.resolve({ faces: 2 })),
}));
jest.mock('../../src/services/faceClustering', () => ({
  recluster: jest.fn(() => Promise.resolve(4)),
}));
jest.mock('../../src/services/facePeopleService', () => ({}));
jest.mock('../../src/services/faceClient', () => ({}));
jest.mock('../../src/services/faceAutoCategories', () => ({
  undoEvent: jest.fn(() => Promise.resolve({ undone: 5 })),
}));
jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

function buildApp() {
  const router = express.Router();
  require('../../src/routes/adminEvents/faces')(router);
  const app = express();
  app.use(express.json());
  app.use('/events', router);
  return app;
}

const actor = { type: 'admin', id: ADMIN.id, name: ADMIN.username };

describe('faces routes log activity in the positional shape (issue 1978)', () => {
  let app;
  beforeAll(() => { app = buildApp(); });
  beforeEach(() => mockLogActivity.mockClear());

  const cases = [
    ['PATCH', `/events/${EVENT.id}/faces`, { enabled: true },
      'event_faces_updated', { face_recognition_enabled: true, queued: 3 }, EVENT.id],
    ['POST', `/events/${EVENT.id}/faces/rescan`, undefined,
      'event_faces_rescan', { queued: 3 }, EVENT.id],
    ['POST', `/events/${EVENT.id}/faces/recluster`, undefined,
      'event_faces_recluster', { people: 4 }, EVENT.id],
    ['DELETE', `/events/${EVENT.id}/faces/categorize`, undefined,
      'event_faces_categories_undone', { undone: 5 }, EVENT.id],
    ['DELETE', `/events/${EVENT.id}/faces`, undefined,
      'event_faces_purged', { faces: 2 }, EVENT.id],
    // The global toggle belongs to no gallery.
    ['PUT', '/events/faces/auto-categories', { enabled: true },
      'face_auto_categories_toggled', { enabled: true }, null],
  ];

  it.each(cases)('%s %s', async (method, url, body, type, metadata, eventId) => {
    const res = await request(app)[method.toLowerCase()](url).send(body);
    expect(res.status).toBe(200);
    expect(mockLogActivity).toHaveBeenCalledTimes(1);
    expect(mockLogActivity).toHaveBeenCalledWith(type, metadata, eventId, actor);
  });
});
