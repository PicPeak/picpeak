'use strict';

// An unexpected failure on an admin route used to echo the thrown message in
// the 500 body (`details: error.message`), which carries table names, storage
// keys or a backend's own text. The message stays in the server log; the
// client gets a stable generic string.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long!!';

const request = require('supertest');
const { bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp } = require('../integration/helpers/crmDb');

let db, cleanup, app, adminId;

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  ({ adminId } = await seedMinimal(db));
  await assignAdminRole(db, adminId);
  require('../../src/middleware/permissions').clearPermissionCache();
  app = buildRouteApp('/email', require('../../src/routes/adminEmail'));
}, 120000);

afterAll(async () => { if (cleanup) await cleanup(); });

it('answers a database failure on the email queue list with a generic body, not the SQL error', async () => {
  await db.raw('ALTER TABLE email_queue RENAME TO email_queue_hidden');
  try {
    const res = await request(app).get('/email/queue').set('Authorization', `Bearer ${mintAdminToken(adminId)}`);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to load email queue' });
    expect(JSON.stringify(res.body)).not.toMatch(/email_queue|SQLITE|no such table/i);
  } finally {
    await db.raw('ALTER TABLE email_queue_hidden RENAME TO email_queue');
  }
});
