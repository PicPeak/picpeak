/**
 * "Finish selection" at gallery creation (issue 1733).
 *
 * The create form offers the per-gallery switch, so POST /api/admin/events
 * has to store it on the new gallery's feedback settings row: on when sent,
 * off when left out, and refused when it is not a boolean.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-selection-create-')), 'db.sqlite');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'selection-create-test-secret';
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-selection-create-storage-'));

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const { bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken } = require('../integration/helpers/crmDb');

describe('creating a gallery with "Finish selection"', () => {
  let db; let cleanup; let app; let token;
  let counter = 0;
  const createEvent = (over = {}) => {
    counter += 1;
    return request(app).post('/api/admin/events').set('Authorization', `Bearer ${token}`).send({
      event_type: 'wedding', event_name: `Selection Create ${counter}`, event_date: '2026-09-07',
      customer_name: 'Ada', customer_email: 'ada@example.com', admin_email: 'admin@example.com',
      require_password: true, password: 'Meadow-Lark-77!', expiration_days: 30,
      feedback_enabled: true, ...over,
    });
  };
  const storedFlag = async (eventId) => {
    const row = await db('event_feedback_settings').where({ event_id: eventId }).first();
    expect(row).toBeTruthy();
    return Boolean(row.allow_selection_submit);
  };

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    const { adminId } = await seedMinimal(db);
    await assignAdminRole(db, adminId, 'super_admin');
    token = mintAdminToken(adminId);
    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/admin/events', require('../../src/routes/adminEvents'));
    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => { res.status(err.statusCode || err.status || 500).json({ error: err.message, code: err.code }); });
  }, 120000);
  afterAll(async () => { if (cleanup) await cleanup(); });

  it('stores the switch on when the form sent it on', async () => {
    const res = await createEvent({ allow_selection_submit: true });
    expect([200, 201]).toContain(res.status);
    expect(await storedFlag(res.body.id)).toBe(true);
  });

  it('stores it off when the form left it out', async () => {
    const res = await createEvent();
    expect([200, 201]).toContain(res.status);
    expect(await storedFlag(res.body.id)).toBe(false);
  });

  it('stores it off when the form sent it off', async () => {
    const res = await createEvent({ allow_selection_submit: false });
    expect([200, 201]).toContain(res.status);
    expect(await storedFlag(res.body.id)).toBe(false);
  });

  it('refuses a value that is not a boolean', async () => {
    const res = await createEvent({ allow_selection_submit: 'sometimes' });
    expect(res.status).toBe(400);
  });
});
