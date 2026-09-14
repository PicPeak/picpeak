/**
 * Contract signing tokens and signature evidence.
 *
 *  - Sending a contract and a customer signature logged the signing link's
 *    token in activity_logs metadata, which the notifications feed, the
 *    dashboard activity feed and the contract audit trail serve to admins.
 *    New writes log the token row id; migration 216 scrubs the rows on disk.
 *  - The customer signature, the countersignature and the signed-PDF upload
 *    each read the contract state, then wrote unconditionally. Requests
 *    arriving together all passed the checks and the later write replaced the
 *    earlier evidence. The writes are now compare-and-set, and a late PDF stamp
 *    no longer replaces a newer authoritative PDF.
 *  - A token without an expiry was treated as valid forever by the services.
 */

const fs = require('fs');
const path = require('path');
const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

jest.setTimeout(120000);

// 1x1 transparent PNG — smallest valid signature pad output.
const SIGNATURE_DATA_URL = 'data:image/png;base64,'
  + 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const HEX_TOKEN = /[a-f0-9]{64}/i;

let db;
let cleanup;
let tmpDir;
let adminId;
let customerId;
let contractService;
let quoteService;
let pdfStampService;
const prevCwd = process.cwd();
const isPg = () => db.client.config.client === 'pg';

async function enableFlag(key) {
  const updated = await db('feature_flags').where({ key }).update({ value: true });
  if (!updated) await db('feature_flags').insert({ key, value: true });
}

async function sentContract(title = 'Hochzeit') {
  const id = await contractService.createContract({ customerAccountId: customerId, title }, adminId);
  const { token } = await contractService.sendContract(id, adminId);
  return { id, token };
}

function filesUnder(dir, ext) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(full, ext));
    else if (full.endsWith(ext)) out.push(full);
  }
  return out;
}

const signaturePngs = () => filesUnder(process.env.STORAGE_PATH, '.png')
  .filter((file) => file.includes(`${path.sep}signatures${path.sep}`) || /signature/i.test(path.basename(file)));

const metadataOf = (row) => (typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata);

beforeAll(async () => {
  ({ db, cleanup, tmpDir } = await bootCrmDb());
  process.chdir(tmpDir);
  db.client.pool.acquireTimeoutMillis = 2000;
  // Same Date-binding normalisation as crmMintPaths: under jest a service's
  // `new Date()` is a foreign-realm Date that node-sqlite3 stringifies.
  const clientProto = Object.getPrototypeOf(db.client);
  const origQuery = clientProto._query;
  clientProto._query = function patchedQuery(connection, obj) {
    if (obj && Array.isArray(obj.bindings)) {
      obj.bindings = obj.bindings.map(
        (b) => (b && typeof b === 'object' && typeof b.toISOString === 'function' ? b.toISOString() : b),
      );
    }
    return origQuery.call(this, connection, obj);
  };
  ({ adminId, customerId } = await seedMinimal(db));
  await enableFlag('contracts');
  await enableFlag('quotes');
  contractService = require('../../src/services/contractService');
  quoteService = require('../../src/services/quoteService');
  pdfStampService = require('../../src/services/pdfStampService');
});

afterAll(async () => {
  process.chdir(prevCwd);
  if (cleanup) await cleanup();
});

describe('signing tokens in the activity log', () => {
  it('logs the token row id, never the token, when a contract is sent and signed', async () => {
    const { id, token } = await sentContract();
    await contractService.recordCustomerSignature({ token, name: 'Maria Meier', accepted: true, ip: '198.51.100.7' });
    const tokenRow = await db('contract_action_tokens').where({ token }).first();

    const rows = await db('activity_logs').whereIn('activity_type', ['contract_sent', 'contract_signed_by_customer']);
    const forContract = rows.map(metadataOf).filter((meta) => meta.contractId === id);

    expect(forContract).toHaveLength(2);
    for (const meta of forContract) {
      expect(meta.tokenId).toBe(tokenRow.id);
      expect(meta).not.toHaveProperty('token');
      expect(JSON.stringify(meta)).not.toMatch(HEX_TOKEN);
    }
  });

  it('migration 216 scrubs legacy rows and is idempotent', async () => {
    const { id, token } = await sentContract('Legacy');
    const tokenRow = await db('contract_action_tokens').where({ token }).first();
    const orphanToken = 'b'.repeat(64);
    const insert = async (activityType, metadata) => {
      const inserted = await db('activity_logs').insert({
        activity_type: activityType, actor_type: 'system', metadata: JSON.stringify(metadata),
        created_at: new Date().toISOString(),
      }).returning('id');
      return inserted[0]?.id ?? inserted[0];
    };
    const legacyContract = await insert('contract_signed_by_customer', { contractId: id, token });
    const legacyQuote = await insert('quote_accepted', { quoteId: 99, token: orphanToken });
    const unrelated = await insert('event_created', { eventId: 1, token: 'keep-me' });

    const migration = require('../../migrations/core/216_scrub_action_tokens_from_activity_logs');
    await migration.up(db);
    const read = async (rowId) => metadataOf(await db('activity_logs').where({ id: rowId }).first());

    expect(await read(legacyContract)).toEqual({ contractId: id, tokenId: tokenRow.id });
    expect(await read(legacyQuote)).toEqual({ quoteId: 99 });
    expect(await read(unrelated)).toEqual({ eventId: 1, token: 'keep-me' });

    const before = await db('activity_logs').whereIn('id', [legacyContract, legacyQuote, unrelated]).orderBy('id');
    await migration.up(db);
    const after = await db('activity_logs').whereIn('id', [legacyContract, legacyQuote, unrelated]).orderBy('id');
    expect(after.map(metadataOf)).toEqual(before.map(metadataOf));
  });
});

describe('signature evidence under concurrent requests', () => {
  it('lets one of two simultaneous customer signatures through and keeps its evidence', async () => {
    const { id, token } = await sentContract('Race sign');
    const pngsBefore = signaturePngs().length;

    const names = ['Anna Winner', 'Bert Racer'];
    const results = await Promise.allSettled(names.map((name) => contractService.recordCustomerSignature({
      token, name, accepted: true, ip: '198.51.100.8', signatureDataUrl: SIGNATURE_DATA_URL,
    })));

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason.code).toBe('TOKEN_ALREADY_USED');

    const winner = names[results.indexOf(fulfilled[0])];
    const contract = await db('contracts').where({ id }).first();
    expect(contract.signed_customer_name).toBe(winner);
    expect(fs.existsSync(contract.signed_customer_signature_path)).toBe(true);
    // The loser's signature image was removed with its rolled-back write.
    expect(signaturePngs().length).toBe(pngsBefore + 1);
    expect((await db('contract_action_tokens').where({ token }).first()).used_at).toBeTruthy();
  });

  it('lets one of two simultaneous countersignatures through', async () => {
    const { id, token } = await sentContract('Race countersign');
    await contractService.recordCustomerSignature({ token, name: 'Maria Meier', accepted: true, ip: '198.51.100.9' });

    const results = await Promise.allSettled(['Admin One', 'Admin Two'].map((name) => (
      contractService.recordAdminCountersignature(id, { name, ip: '203.0.113.5' }, adminId)
    )));

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason.code).toBe('CONTRACT_STATE_CHANGED');
    const winner = ['Admin One', 'Admin Two'][results.indexOf(fulfilled[0])];
    expect((await db('contracts').where({ id }).first()).signed_admin_name).toBe(winner);
  });

  it('settles a signature racing a signed-PDF upload with one winner and no orphan file', async () => {
    const { id, token } = await sentContract('Race upload');
    const uploadDir = path.join(process.env.STORAGE_PATH, 'uploads', 'contracts', 'signed');
    fs.mkdirSync(uploadDir, { recursive: true });
    const uploaded = path.join(uploadDir, `race-${Date.now()}.pdf`);
    fs.writeFileSync(uploaded, '%PDF-1.4 wet-signed copy');
    const pngsBefore = signaturePngs().length;

    const [sign, upload] = await Promise.allSettled([
      contractService.recordCustomerSignature({
        token, name: 'Maria Meier', accepted: true, ip: '198.51.100.10', signatureDataUrl: SIGNATURE_DATA_URL,
      }),
      contractService.attachSignedPdfUpload(id, uploaded, 'customer'),
    ]);

    expect([sign.status, upload.status].filter((s) => s === 'fulfilled')).toHaveLength(1);
    const contract = await db('contracts').where({ id }).first();
    if (upload.status === 'rejected') {
      expect(upload.reason.code).toBe('CONTRACT_STATE_CHANGED');
      expect(fs.existsSync(uploaded)).toBe(false);
      expect(contract.signed_customer_name).toBe('Maria Meier');
    } else {
      expect(sign.reason.code).toBe('TOKEN_ALREADY_USED');
      expect(signaturePngs().length).toBe(pngsBefore);
      expect(contract.signed_pdf_path).toBe(uploaded);
      expect(contract.status).toBe('fully_signed');
    }
  });

  it('does not let a late customer stamp replace a wet-signed upload that landed meanwhile', async () => {
    const { id, token } = await sentContract('Late stamp');
    const uploadDir = path.join(process.env.STORAGE_PATH, 'uploads', 'contracts', 'signed');
    fs.mkdirSync(uploadDir, { recursive: true });
    const wet = path.join(uploadDir, `wet-${Date.now()}.pdf`);
    fs.writeFileSync(wet, '%PDF-1.4 authoritative wet-signed copy');

    const realStamp = pdfStampService.stampSignature;
    const spy = jest.spyOn(pdfStampService, 'stampSignature').mockImplementationOnce(async (args) => {
      // The admin uploads the wet-signed copy while the customer's stamp renders.
      await contractService.attachSignedPdfUpload(id, wet, 'admin');
      return realStamp.call(pdfStampService, args);
    });
    try {
      await contractService.recordCustomerSignature({
        token, name: 'Maria Meier', accepted: true, ip: '198.51.100.11', signatureDataUrl: SIGNATURE_DATA_URL,
      });
    } finally {
      spy.mockRestore();
    }

    const contract = await db('contracts').where({ id }).first();
    expect(contract.status).toBe('fully_signed');
    expect(contract.signed_pdf_path).toBe(wet);
  });
});

describe('admin PDF repair actions under concurrent requests', () => {
  async function customerSigned(title) {
    const { id, token } = await sentContract(title);
    await contractService.recordCustomerSignature({ token, name: 'Maria Meier', accepted: true, ip: '198.51.100.20' });
    return id;
  }

  it('lets one of two simultaneous re-stamps through and removes the loser\'s image', async () => {
    const id = await customerSigned('Race restamp');
    const pngsBefore = signaturePngs().length;

    const results = await Promise.allSettled([1, 2].map(() => (
      contractService.restampSignatures(id, { customerSignatureDataUrl: SIGNATURE_DATA_URL }, adminId)
    )));

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason.code).toBe('CONTRACT_STATE_CHANGED');
    const contract = await db('contracts').where({ id }).first();
    expect(fs.existsSync(contract.signed_customer_signature_path)).toBe(true);
    expect(signaturePngs().length).toBe(pngsBefore + 1);
  });

  it('does not let a late re-stamp replace a wet-signed upload that landed meanwhile', async () => {
    const id = await customerSigned('Late restamp');
    const uploadDir = path.join(process.env.STORAGE_PATH, 'uploads', 'contracts', 'signed');
    fs.mkdirSync(uploadDir, { recursive: true });
    const wet = path.join(uploadDir, `wet-restamp-${Date.now()}.pdf`);
    fs.writeFileSync(wet, '%PDF-1.4 authoritative wet-signed copy');

    const realStamp = pdfStampService.stampSignatures;
    const spy = jest.spyOn(pdfStampService, 'stampSignatures').mockImplementationOnce(async (...args) => {
      // The admin uploads the wet-signed copy while the re-stamp renders.
      await contractService.attachSignedPdfUpload(id, wet, 'admin');
      return realStamp.apply(pdfStampService, args);
    });
    let result;
    try {
      result = await contractService.restampSignatures(id, { customerSignatureDataUrl: SIGNATURE_DATA_URL }, adminId);
    } finally {
      spy.mockRestore();
    }

    const contract = await db('contracts').where({ id }).first();
    expect(contract.signed_pdf_path).toBe(wet);
    expect(result.superseded).toBe(true);
    expect(result.signedPdfPath).toBe(wet);
  });

  it('refuses a re-send whose rebuilt PDF was overtaken, and mails nothing', async () => {
    const id = await customerSigned('Race resend');
    await contractService.recordAdminCountersignature(id, { name: 'Admin', ip: '203.0.113.20' }, adminId);
    const signedBefore = (await db('contracts').where({ id }).first()).signed_pdf_path;
    const mailsBefore = (await db('email_queue').where({ email_type: 'contract_fully_signed' })).length;

    const realStamp = pdfStampService.stampSignatures;
    const spy = jest.spyOn(pdfStampService, 'stampSignatures').mockImplementationOnce(async (...args) => {
      // Another admin re-stamps while the re-send rebuilds the PDF.
      await contractService.restampSignatures(id, { adminSignatureDataUrl: SIGNATURE_DATA_URL }, adminId);
      return realStamp.apply(pdfStampService, args);
    });
    try {
      await expect(contractService.rerenderAndResend(id, adminId))
        .rejects.toMatchObject({ statusCode: 409, code: 'CONTRACT_STATE_CHANGED' });
    } finally {
      spy.mockRestore();
    }

    const contract = await db('contracts').where({ id }).first();
    expect(contract.signed_pdf_path).not.toBe(signedBefore);
    expect((await db('email_queue').where({ email_type: 'contract_fully_signed' })).length).toBe(mailsBefore);
  });
});

describe('tokens without an expiry', () => {
  // Postgres rejects an empty timestamp and the column is NOT NULL, so a
  // missing expiry can only be staged on SQLite.
  const sqliteOnly = (name, fn) => it(name, async () => {
    if (isPg()) return;
    await fn();
  });

  sqliteOnly('refuses a contract signature', async () => {
    const { id, token } = await sentContract('No expiry');
    await db('contract_action_tokens').where({ token }).update({ expires_at: '' });

    await expect(contractService.recordCustomerSignature({ token, name: 'Maria Meier', accepted: true }))
      .rejects.toMatchObject({ statusCode: 410 });
    expect((await db('contracts').where({ id }).first()).status).toBe('sent');
  });

  sqliteOnly('refuses a quote answer', async () => {
    const quoteId = await quoteService.createQuote({
      customerAccountId: customerId,
      currency: 'CHF',
      vatRate: 0,
      lineItems: [{ position: 1, quantity: 1, description: 'Photo package', unit_price_minor: 150000, discount_percent: 0 }],
    }, adminId);
    await db('quotes').where({ id: quoteId }).update({ status: 'sent' });
    const token = 'c'.repeat(64);
    await db('quote_action_tokens').insert({ quote_id: quoteId, token, expires_at: '', created_at: new Date().toISOString() });

    await expect(quoteService.recordResponse({ token, action: 'accept' })).rejects.toMatchObject({ statusCode: 410 });
    expect((await db('quotes').where({ id: quoteId }).first()).status).toBe('sent');
  });
});
