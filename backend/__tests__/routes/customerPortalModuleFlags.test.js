'use strict';

// The portal's quote and invoice routes follow the Quotes / Bills switches in
// Settings → Features (feature_flags), together with the older
// customer_surface switch and the per-customer flag.
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-portal-flags-test-'));
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

let db, cleanup, app, cookie, quoteId, customerId;

async function setFlag(key, on) {
  const value = require('../../src/utils/dbCompat').formatBoolean(on);
  if (await db('feature_flags').where({ key }).first()) await db('feature_flags').where({ key }).update({ value });
  else await db('feature_flags').insert({ key, value });
}

async function setSurface(key, value) {
  await db('app_settings').where({ setting_key: key }).del();
  if (value !== undefined) {
    await db('app_settings').insert({ setting_key: key, setting_value: JSON.stringify(value), setting_type: 'customer_surface' });
  }
}

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  ({ customerId } = await seedMinimal(db));
  await db('customer_accounts').where({ id: customerId }).update({ feature_quotes: true, feature_bills: true });
  const [row] = await db('quotes').insert({ quote_number: 'Q-FLAG-1', customer_account_id: customerId, currency: 'CHF',
    status: 'sent', language: 'de', issue_date: '2026-06-01', net_amount_minor: 10000, vat_amount_minor: 0,
    total_amount_minor: 10000, created_at: new Date().toISOString() }).returning('id');
  quoteId = row?.id ?? row;
  const session = jwt.sign({ type: 'customer', customerId, iat: Math.floor(Date.now() / 1000) - 5 },
    process.env.JWT_SECRET, { algorithm: 'HS256', issuer: 'picpeak-auth', expiresIn: '1h' });
  cookie = `customer_token=${session}`;
  app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/customer', require('../../src/routes/customer'));
  app.use(require('../../src/middleware/errorHandler').errorHandler);
}, 120000);
afterAll(async () => { if (cleanup) await cleanup(); });

const statuses = async () => {
  const get = url => request(app).get(url).set('Cookie', cookie).then(r => r.status);
  return {
    quotes: await get('/api/customer/quotes'),
    quote: await get(`/api/customer/quotes/${quoteId}`),
    invoices: await get('/api/customer/invoices'),
  };
};

test.each([
  ['the older switch on', true],
  ['the older switch absent', undefined],
])('Quotes and Bills switched off in Features close the portal routes (%s)', async (_label, surface) => {
  await setSurface('customer_feature_quotes_enabled', surface);
  await setSurface('customer_feature_bills_enabled', surface);
  await setFlag('quotes', false);
  await setFlag('bills', false);
  expect(await statuses()).toEqual({ quotes: 403, quote: 403, invoices: 403 });
  const features = await require('../../src/services/customerAccountsService').getEffectiveFeaturesForCustomer(customerId);
  expect(features).toEqual(expect.objectContaining({ quotes: false, bills: false }));
});

test('switched on in Features with the older switch on, the routes open', async () => {
  await setSurface('customer_feature_quotes_enabled', true);
  await setSurface('customer_feature_bills_enabled', true);
  await setFlag('quotes', true);
  await setFlag('bills', true);
  expect(await statuses()).toEqual({ quotes: 200, quote: 200, invoices: 200 });
});

test('an install that had the portal tabs off keeps them off', async () => {
  await setSurface('customer_feature_quotes_enabled', false);
  await setSurface('customer_feature_bills_enabled', false);
  await setFlag('quotes', true);
  await setFlag('bills', true);
  expect(await statuses()).toEqual({ quotes: 403, quote: 403, invoices: 403 });
});

test('the per-customer flag still closes them', async () => {
  await setSurface('customer_feature_quotes_enabled', true);
  await setSurface('customer_feature_bills_enabled', true);
  await setFlag('quotes', true);
  await setFlag('bills', true);
  await db('customer_accounts').where({ id: customerId }).update({ feature_quotes: false, feature_bills: false });
  try {
    expect(await statuses()).toEqual({ quotes: 403, quote: 403, invoices: 403 });
  } finally {
    await db('customer_accounts').where({ id: customerId }).update({ feature_quotes: true, feature_bills: true });
  }
});
