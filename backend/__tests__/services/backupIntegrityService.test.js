/**
 * Verifies the backup-integrity check covers every CRM document
 * artefact column and correctly buckets each row into:
 *   - verifiedOk      — file exists AND hash matches (when hash is stored)
 *   - missing         — `*_path` set but file is not on disk
 *   - hashMismatches  — file exists but bytes don't hash to `*_sha256`
 *   - existsButNoHash — file exists, no `*_sha256` column for this row
 *
 * Uses the CRM integration harness (bootCrmDb) so the schema +
 * STORAGE_PATH wiring exactly mirrors production behaviour.
 *
 * Background: this service is the diagnostic for the
 * `storage/business-docs/` gap fixed in the same PR — without it,
 * a restored install would have audit-trail columns referencing
 * files that no longer exist, but admins would have no way to see
 * the breakage until a customer asked for their contract back.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');

jest.setTimeout(30000);

describe('backupIntegrityService.verifyDocumentArtefacts', () => {
  let db;
  let cleanup;
  let customerId;
  let storagePath;
  let backupIntegrityService;

  function seedFile(relPath, content) {
    const abs = path.join(storagePath, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    return { abs, relPath, sha: sha256(content) };
  }

  function sha256(content) {
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    ({ customerId } = await seedMinimal(db));
    storagePath = process.env.STORAGE_PATH;
    backupIntegrityService = require('../../src/services/backupIntegrityService');
  }, 120000);

  afterAll(async () => {
    if (cleanup) await cleanup();
  });

  beforeEach(async () => {
    // Wipe CRM rows between tests so each scenario sees a clean slate.
    // Order matters: child tables before parents.
    await db('invoice_line_items').del().catch(() => {});
    await db('invoice_payment_log').del().catch(() => {});
    await db('invoices').del().catch(() => {});
    await db('quote_line_items').del().catch(() => {});
    await db('quotes').del().catch(() => {});
    await db('contracts').del().catch(() => {});
  });

  it('returns an empty report when no documents reference any path', async () => {
    const report = await backupIntegrityService.verifyDocumentArtefacts();
    expect(report.summary.totalRows).toBe(0);
    expect(report.summary.verifiedOk).toBe(0);
    expect(report.missing).toEqual([]);
    expect(report.hashMismatches).toEqual([]);
    expect(report.existsButNoHash).toEqual([]);
    expect(report.scannedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(report.scopes).toEqual(expect.arrayContaining(['quote', 'contract', 'contract-signature', 'invoice']));
  });

  it('flags a contract whose signed_pdf_path file is missing', async () => {
    // Reference a file that we deliberately never create on disk.
    // knex's `.returning('id')` returns `[{ id: N }]` on Postgres and
    // newer SQLite, but `[N]` (plain int) on some SQLite versions —
    // unwrap both shapes the same way the crmDb test harness does.
    const inserted = await db('contracts').insert({
      customer_account_id: customerId,
      contract_number: 'C-2026-MISSING',
      status: 'sent',
      issue_date: '2026-01-01',
      signed_pdf_path: 'business-docs/contract/2026/C-2026-MISSING.pdf',
      created_at: new Date(),
    }).returning('id');
    const contractId = typeof inserted[0] === 'object' ? inserted[0].id : inserted[0];

    const report = await backupIntegrityService.verifyDocumentArtefacts({ scope: ['contract'] });
    const hit = report.missing.find((m) => m.rowId === contractId);
    expect(hit).toMatchObject({
      table: 'contracts',
      column: 'signed_pdf_path',
      expectedPath: 'business-docs/contract/2026/C-2026-MISSING.pdf',
    });
    expect(report.summary.missingFiles).toBe(1);
  });

  it('verifies a contract whose file exists AND hash matches', async () => {
    const { relPath, sha } = seedFile(
      'business-docs/contract/2026/C-2026-OK.pdf',
      'this is the signed contract content',
    );
    await db('contracts').insert({
      customer_account_id: customerId,
      contract_number: 'C-2026-OK',
      status: 'fully_signed',
      issue_date: '2026-01-01',
      signed_pdf_path: relPath,
      signed_pdf_sha256: sha,
      created_at: new Date(),
    });

    const report = await backupIntegrityService.verifyDocumentArtefacts({ scope: ['contract'] });
    expect(report.summary.verifiedOk).toBeGreaterThanOrEqual(1);
    expect(report.summary.missingFiles).toBe(0);
    expect(report.summary.hashMismatches).toBe(0);
  });

  it('flags a hash mismatch when the file exists but bytes differ from signed_pdf_sha256', async () => {
    const { relPath } = seedFile(
      'business-docs/contract/2026/C-2026-TAMPER.pdf',
      'tampered bytes on disk',
    );
    const inserted = await db('contracts').insert({
      customer_account_id: customerId,
      contract_number: 'C-2026-TAMPER',
      status: 'fully_signed',
      issue_date: '2026-01-01',
      signed_pdf_path: relPath,
      // Hash for completely different content — simulates tampering or
      // bit-rot between sign-time and now.
      signed_pdf_sha256: sha256('the ORIGINAL bytes the customer signed'),
      created_at: new Date(),
    }).returning('id');
    const contractId = typeof inserted[0] === 'object' ? inserted[0].id : inserted[0];

    const report = await backupIntegrityService.verifyDocumentArtefacts({ scope: ['contract'] });
    const hit = report.hashMismatches.find((m) => m.rowId === contractId);
    expect(hit).toBeDefined();
    expect(hit.expectedSha).not.toBe(hit.actualSha);
    expect(hit.column).toBe('signed_pdf_path');
  });

  it('buckets signature PNGs into existsButNoHash (no hash column)', async () => {
    const { relPath } = seedFile(
      'business-docs/contract/signatures/99/customer-1700000000000.png',
      '\x89PNG\r\n\x1a\n', // doesn't have to be a real PNG, just bytes
    );
    await db('contracts').insert({
      customer_account_id: customerId,
      contract_number: 'C-2026-SIG',
      status: 'fully_signed',
      issue_date: '2026-01-01',
      signed_customer_signature_path: relPath,
      created_at: new Date(),
    });

    const report = await backupIntegrityService.verifyDocumentArtefacts({
      scope: ['contract-signature'],
    });
    expect(report.summary.existsButNoHash).toBeGreaterThanOrEqual(1);
    expect(report.summary.verifiedOk).toBe(0); // no hash → not "verified ok"
    expect(report.summary.missingFiles).toBe(0);
    const hit = report.existsButNoHash.find((r) => r.column === 'signed_customer_signature_path');
    expect(hit).toBeDefined();
  });

  it('respects the scope filter — contract scope skips quote/invoice tables', async () => {
    // Seed an invoice with a missing pdf_path AND a contract with a
    // missing signed_pdf_path. Scoping to contract should only flag
    // the contract.
    await db('invoices').insert({
      customer_account_id: customerId,
      invoice_number: 'INV-2026-SCOPE',
      status: 'sent',
      pdf_path: 'business-docs/invoice/2026/INV-2026-SCOPE.pdf',
      issue_date: '2026-01-01',
      due_date: '2026-01-31',
      created_at: new Date(),
    });
    await db('contracts').insert({
      customer_account_id: customerId,
      contract_number: 'C-2026-SCOPE',
      status: 'sent',
      issue_date: '2026-01-01',
      signed_pdf_path: 'business-docs/contract/2026/C-2026-SCOPE.pdf',
      created_at: new Date(),
    });

    const report = await backupIntegrityService.verifyDocumentArtefacts({ scope: ['contract'] });
    expect(report.scopes).toEqual(['contract']);
    expect(report.missing.every((m) => m.table === 'contracts')).toBe(true);
    expect(report.missing.some((m) => m.table === 'invoices')).toBe(false);
  });

  it('covers invoices.imported_pdf_path (admin-uploaded historical scans)', async () => {
    // Imported invoices are the most catastrophic case — there's no
    // renderer that can reproduce them. Verifier must check this column
    // alongside invoices.pdf_path.
    await db('invoices').insert({
      customer_account_id: customerId,
      invoice_number: 'IMP-2025-001',
      status: 'sent',
      imported_pdf_path: 'business-docs/invoice-imports/2025/legacy.pdf',
      issue_date: '2025-06-01',
      due_date: '2025-07-01',
      created_at: new Date(),
    });

    const report = await backupIntegrityService.verifyDocumentArtefacts({ scope: ['invoice'] });
    const hit = report.missing.find((m) => m.column === 'imported_pdf_path');
    expect(hit).toBeDefined();
  });
});
