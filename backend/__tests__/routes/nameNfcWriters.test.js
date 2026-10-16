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

  it('still finds a name saved decomposed before the change, with either spelling', async () => {
    // No backfill: rows written before NFC keep their decomposed form.
    await db('customer_accounts').where({ id: customerId })
      .update({ display_name: `${DECOMPOSED} Legacy`, is_active: true });
    const service = require('../../src/services/customerAccountsService');
    for (const query of [`${DECOMPOSED} legacy`, `${PRECOMPOSED} legacy`]) {
      expect((await service.listCustomers({ search: query })).map((c) => c.id)).toContain(customerId);
      expect((await service.searchCustomers(query)).map((c) => c.id)).toContain(customerId);
    }
  });

  it('stores the company name a customer sends with contract details in NFC', () => {
    const { validateDetails } = require('../../src/services/contract/dataCollection');
    const out = validateDetails({ company_name: ' Ba\u0308ckerei ' }, { fields: ['company_name'], required: [] });
    expect(out.company_name).toBe('B\u00e4ckerei');
  });

  it('finds quotes, invoices and contracts by a company name with either spelling', async () => {
    await db('customer_accounts').where({ id: customerId }).update({ company_name: 'B\u00e4ckerei Nord' });
    const now = new Date().toISOString();
    const today = now.slice(0, 10);
    await db('quotes').insert({
      quote_number: 'Q-NFC-1', customer_account_id: customerId, currency: 'CHF', status: 'draft', language: 'de',
      issue_date: today, net_amount_minor: 100, vat_amount_minor: 0, total_amount_minor: 100, created_at: now,
    });
    await db('contracts').insert({
      contract_number: 'K-NFC-1', customer_account_id: customerId, title: 'Vertrag', status: 'draft',
      language: 'de', issue_date: today, created_at: now,
    });
    await db('invoices').insert({
      invoice_number: 'R-NFC-1', customer_account_id: customerId, currency: 'CHF', status: 'draft',
      language: 'de', issue_date: today, due_date: today, created_at: now,
    });
    const { listQuotes } = require('../../src/services/quoteService');
    const { listContracts } = require('../../src/services/contract/crud');
    const { listInvoices } = require('../../src/services/invoice/queries');
    for (const q of ['Ba\u0308ckerei', 'B\u00e4ckerei']) {
      expect((await listQuotes({ filters: { q } })).rows.map((r) => r.quote_number)).toContain('Q-NFC-1');
      expect((await listContracts({ filters: { q } })).rows.map((r) => r.contract_number)).toContain('K-NFC-1');
      expect((await listInvoices({ filters: { q } })).rows.map((r) => r.invoice_number)).toContain('R-NFC-1');
    }
  });

  describe('rename slugs strip accents like utils/slug.js', () => {
    const date = '2026-08-01';
    const slugOf = (name) => require('../../src/services/eventRenameService').generateSlug('wedding', name, date);
    const tail = slugOf('x').replace(/^wedding-x-/, '');

    it('gives NFC, NFD and mixed input the same slug', () => {
      expect(slugOf(PRECOMPOSED)).toBe(`wedding-jorg-${tail}`);
      expect(slugOf(DECOMPOSED)).toBe(`wedding-jorg-${tail}`);
      expect(slugOf(`${PRECOMPOSED} und ${DECOMPOSED}`)).toBe(`wedding-jorg-und-jorg-${tail}`);
    });

    it('treats umlauts and sharp s exactly as slugify does', () => {
      const { slugify } = require('../../src/utils/slug');
      for (const name of ['\u00c4rger \u00fcber \u00d6l', 'Stra\u00dfe', 'Fam\u00edlia Decora\u00e7\u00e3o']) {
        expect(slugOf(name)).toBe(`wedding-${slugify(name)}-${tail}`);
      }
      expect(slugOf('\u00c4rger \u00fcber \u00d6l')).toBe(`wedding-arger-uber-ol-${tail}`);
      expect(slugOf('Stra\u00dfe')).toBe(`wedding-stra-e-${tail}`);
    });

    it('slugs an ASCII name exactly as the old pipeline did', () => {
      const old = (n) => n.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
      for (const name of ['Anna & Ben', '  Summer -- Party 2026! ', 'x_y.z']) {
        expect(slugOf(name)).toBe(`wedding-${old(name)}-${tail}`);
      }
    });
  });
});
