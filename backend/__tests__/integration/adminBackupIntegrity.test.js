/**
 * Integration test for GET /api/admin/system-health/backup-integrity.
 *
 * Auth + permission middleware are mocked to pass-through so the test
 * focuses on the route's own behaviour: scope-param validation, the
 * successResponse envelope, and that the underlying service report
 * surfaces correctly in the JSON body.
 *
 * The verifier service itself is exercised against the real schema
 * (bootCrmDb) and real filesystem — only the auth gate is stubbed.
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');

const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

// Pass-through auth so we don't need to mint JWTs.
jest.mock('../../src/middleware/auth', () => ({
  adminAuth: (req, _res, next) => { req.admin = { id: 1 }; next(); },
  customerAuth: (_req, _res, next) => next(),
  galleryAuth: (_req, _res, next) => next(),
}));

// Pass-through permissions so settings.view always allows.
jest.mock('../../src/middleware/permissions', () => ({
  requirePermission: () => (_req, _res, next) => next(),
}));

jest.setTimeout(30000);

describe('GET /api/admin/system-health/backup-integrity', () => {
  let cleanup;
  let db;
  let customerId;
  let app;
  let storagePath;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    ({ customerId } = await seedMinimal(db));
    storagePath = process.env.STORAGE_PATH;

    // Mount the route on a minimal Express app. Cold-require after
    // bootCrmDb so the route's downstream `require('../database/db')`
    // sees the same db instance.
    const route = require('../../src/routes/adminSystemHealth');
    app = express();
    app.use(express.json());
    app.use('/api/admin/system-health', route);
  }, 120000);

  afterAll(async () => {
    if (cleanup) await cleanup();
  });

  beforeEach(async () => {
    await db('contracts').del().catch(() => {});
    await db('invoices').del().catch(() => {});
    await db('quotes').del().catch(() => {});
  });

  it('returns a report envelope when nothing references any path', async () => {
    const res = await request(app).get('/api/admin/system-health/backup-integrity');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('report');
    expect(res.body.report.summary).toMatchObject({
      totalRows: 0,
      missingFiles: 0,
      hashMismatches: 0,
      verifiedOk: 0,
      existsButNoHash: 0,
    });
    expect(res.body.report.scopes).toEqual(expect.arrayContaining([
      'quote', 'contract', 'contract-signature', 'invoice',
    ]));
  });

  it('surfaces a missing file in the response payload', async () => {
    await db('contracts').insert({
      customer_account_id: customerId,
      contract_number: 'C-B7-MISSING',
      status: 'sent',
      issue_date: '2026-01-01',
      signed_pdf_path: 'business-docs/contract/2026/C-B7-MISSING.pdf',
      created_at: new Date(),
    });

    const res = await request(app).get('/api/admin/system-health/backup-integrity');
    expect(res.status).toBe(200);
    expect(res.body.report.summary.missingFiles).toBe(1);
    expect(res.body.report.missing[0]).toMatchObject({
      table: 'contracts',
      column: 'signed_pdf_path',
      expectedPath: 'business-docs/contract/2026/C-B7-MISSING.pdf',
    });
  });

  it('honours the ?scope=invoice filter', async () => {
    // Seed both an invoice and a contract with missing files. With
    // scope=invoice the contract row must not appear.
    await db('invoices').insert({
      customer_account_id: customerId,
      invoice_number: 'INV-B7-SCOPE',
      status: 'sent',
      issue_date: '2026-01-01',
      due_date: '2026-01-31',
      pdf_path: 'business-docs/invoice/2026/INV-B7-SCOPE.pdf',
      created_at: new Date(),
    });
    await db('contracts').insert({
      customer_account_id: customerId,
      contract_number: 'C-B7-SCOPE',
      status: 'sent',
      issue_date: '2026-01-01',
      signed_pdf_path: 'business-docs/contract/2026/C-B7-SCOPE.pdf',
      created_at: new Date(),
    });

    const res = await request(app)
      .get('/api/admin/system-health/backup-integrity')
      .query({ scope: 'invoice' });
    expect(res.status).toBe(200);
    expect(res.body.report.scopes).toEqual(['invoice']);
    expect(res.body.report.missing.every((m) => m.table === 'invoices')).toBe(true);
  });

  it('rejects an unknown scope with 400 + a code', async () => {
    const res = await request(app)
      .get('/api/admin/system-health/backup-integrity')
      .query({ scope: 'gallery' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('BACKUP_INTEGRITY_UNKNOWN_SCOPE');
    expect(res.body.validScopes).toEqual(expect.arrayContaining([
      'quote', 'contract', 'contract-signature', 'invoice',
    ]));
  });
});
