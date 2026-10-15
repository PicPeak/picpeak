/**
 * Names are stored in NFC (issue 2079): macOS input arrives decomposed, and a
 * decomposed "Jörg" never matches a precomposed one in LIKE. These pin the
 * writers and searches the admin create/update paths do not cover: the shared
 * event creation validation (admin create, v1 API), the customer portal's
 * self-edit, and the customer searches, whose query has to be normalised the
 * same way or it misses the names stored in NFC.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-name-nfc-test-'));
process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(tmpDir, 'db.sqlite');
process.env.STORAGE_PATH = path.join(tmpDir, 'storage');
fs.mkdirSync(process.env.STORAGE_PATH, { recursive: true });
process.env.JWT_SECRET = process.env.JWT_SECRET || 'crm-route-test-secret';

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');

const DECOMPOSED = 'Jörg';
const PRECOMPOSED = 'Jörg';

describe('names stored and searched in NFC', () => {
  let db;
  let cleanup;
  let app;
  let customerId;
  let cookie;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    ({ customerId } = await seedMinimal(db));
    const session = jwt.sign(
      { type: 'customer', customerId, iat: Math.floor(Date.now() / 1000) - 5 },
      process.env.JWT_SECRET,
      { algorithm: 'HS256', issuer: 'picpeak-auth', expiresIn: '1h' },
    );
    cookie = `customer_token=${session}`;
    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/customer', require('../../src/routes/customer'));
    app.use(require('../../src/middleware/errorHandler').errorHandler);
  }, 120000);

  afterAll(async () => {
    if (cleanup) await cleanup();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('normalises event_name in the shared creation validation', async () => {
    const { validateCreationInput } = require('../../src/services/eventCreationValidation');
    const value = await validateCreationInput({ event_name: `  ${DECOMPOSED} und Anna `, event_type: 'wedding' });
    expect(value.event_name).toBe(`${PRECOMPOSED} und Anna`);
  });

  it('stores the names a customer edits in the portal in NFC', async () => {
    const res = await request(app).put('/api/customer/profile').set('Cookie', cookie).send({
      firstName: DECOMPOSED, lastName: 'Mu\u0308ller', displayName: `${DECOMPOSED} M.`,
      companyName: 'Ba\u0308ckerei', city: 'Zu\u0308rich',
    });
    expect(res.status).toBe(200);
    const row = await db('customer_accounts').where({ id: customerId }).first();
    expect(row.first_name).toBe(PRECOMPOSED);
    expect(row.last_name).toBe('M\u00fcller');
    expect(row.display_name).toBe(`${PRECOMPOSED} M.`);
    expect(row.company_name).toBe('B\u00e4ckerei');
    // Only the name fields; an address stays as typed.
    expect(row.city).toBe('Zu\u0308rich');
  });

  it('finds an NFC name with a decomposed query in the customer list and picker', async () => {
    await db('customer_accounts').where({ id: customerId })
      .update({ display_name: `${PRECOMPOSED} Nfc`, is_active: true });
    const service = require('../../src/services/customerAccountsService');
    const listed = await service.listCustomers({ search: `${DECOMPOSED} nfc` });
    expect(listed.map((c) => c.id)).toContain(customerId);
    const picked = await service.searchCustomers(`${DECOMPOSED} nfc`);
    expect(picked.map((c) => c.id)).toContain(customerId);
  });
});
