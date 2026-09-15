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
 *    no longer replaces a newer authoritative PDF or one built from newer
 *    signature images. The countersignature stamps every signature from the
 *    unsigned PDF, so it no longer loses a customer stamp still rendering.
 *  - A token without an expiry was treated as valid forever by the services.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

jest.setTimeout(120000);

// Runs once before the next getContractById for that contract, which the
// countersignature calls right after its status update.
let mockBeforeContractRead = null;
jest.mock('../../src/services/contract/crud', () => {
  const actual = jest.requireActual('../../src/services/contract/crud');
  return {
    ...actual,
    getContractById: async (id, ...rest) => {
      const hook = mockBeforeContractRead;
      if (hook && Number(id) === hook.contractId) {
        mockBeforeContractRead = null;
        await hook.run();
      }
      return actual.getContractById(id, ...rest);
    },
  };
});

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

const restampLogsFor = async (contractId) => (await db('activity_logs').where({ activity_type: 'contract_signatures_restamped' }))
  .map(metadataOf)
  .filter((meta) => meta.contractId === contractId);

async function pngDataUrl(background) {
  const sharp = require('sharp');
  const png = await sharp({ create: { width: 4, height: 4, channels: 4, background: { ...background, alpha: 1 } } })
    .png().toBuffer();
  return `data:image/png;base64,${png.toString('base64')}`;
}

// Follows which signature images went into each stamped PDF, keyed by the
// PDF's SHA-256 (the value the services store in signed_pdf_sha256).
function recordStamps() {
  const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
  const bySha = new Map();
  const realOne = pdfStampService.stampSignature;
  const realMany = pdfStampService.stampSignatures;
  const recordOne = async (args) => {
    const out = await realOne.call(pdfStampService, args);
    bySha.set(sha256(out), [...(bySha.get(sha256(args.pdfBuffer)) || []), { role: args.role, png: args.signaturePngPath }]);
    return out;
  };
  const recordMany = async (buffer, stamps) => {
    const out = await realMany.call(pdfStampService, buffer, stamps);
    bySha.set(out.sha256, [
      ...(bySha.get(sha256(buffer)) || []),
      ...stamps.map((stamp) => ({ role: stamp.role, png: stamp.signaturePngPath })),
    ]);
    return out;
  };
  const one = jest.spyOn(pdfStampService, 'stampSignature').mockImplementation(recordOne);
  const many = jest.spyOn(pdfStampService, 'stampSignatures').mockImplementation(recordMany);
  return {
    one,
    many,
    recordOne,
    recordMany,
    stampsOf: (sha) => bySha.get(sha) || [],
    restore: () => { one.mockRestore(); many.mockRestore(); },
  };
}

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

  it('keeps the customer signature in the fully-signed PDF when the countersignature lands while the customer stamp renders', async () => {
    const { id, token } = await sentContract('Countersign during stamp');
    const recorder = recordStamps();
    recorder.one.mockImplementationOnce(async (args) => {
      // The admin countersigns before the customer's stamp is on record; the
      // customer stamp is then discarded because the status moved on.
      await contractService.recordAdminCountersignature(
        id, { name: 'Admin', ip: '203.0.113.30', signatureDataUrl: SIGNATURE_DATA_URL }, adminId,
      );
      return recorder.recordOne(args);
    });
    try {
      await contractService.recordCustomerSignature({
        token, name: 'Maria Meier', accepted: true, ip: '198.51.100.12', signatureDataUrl: SIGNATURE_DATA_URL,
      });
    } finally {
      recorder.restore();
    }

    const contract = await db('contracts').where({ id }).first();
    expect(contract.status).toBe('fully_signed');
    expect(recorder.stampsOf(contract.signed_pdf_sha256)).toEqual([
      { role: 'customer', png: contract.signed_customer_signature_path },
      { role: 'admin', png: contract.signed_admin_signature_path },
    ]);
  });
});

describe('customer signature stamping', () => {
  it('does not record its PDF over a re-stamp that replaced the customer image before the stamp read the contract', async () => {
    const { id, token } = await sentContract('Restamp before customer stamp');
    const replacement = await pngDataUrl({ r: 0, g: 120, b: 200 });
    const recorder = recordStamps();
    mockBeforeContractRead = {
      contractId: id,
      run: () => contractService.restampSignatures(id, { customerSignatureDataUrl: replacement }, adminId),
    };
    try {
      await contractService.recordCustomerSignature({
        token, name: 'Maria Meier', accepted: true, ip: '198.51.100.16', signatureDataUrl: SIGNATURE_DATA_URL,
      });
    } finally {
      mockBeforeContractRead = null;
      recorder.restore();
    }

    const contract = await db('contracts').where({ id }).first();
    expect(contract.signed_pdf_path).toBeTruthy();
    // The PDF on record shows the image the contract references.
    expect(recorder.stampsOf(contract.signed_pdf_sha256).map((stamp) => stamp.png))
      .toEqual([contract.signed_customer_signature_path]);
  });
});

describe('countersignature stamping', () => {
  it('sends no fully-signed emails without a recorded PDF carrying both signatures, and leaves them to Re-send', async () => {
    const { id, token } = await sentContract('Countersign during restamp');
    await contractService.recordCustomerSignature({
      token, name: 'Maria Meier', accepted: true, ip: '198.51.100.15', signatureDataUrl: SIGNATURE_DATA_URL,
    });
    const { contract_number: contractNumber, signed_pdf_path: customerOnly } = await db('contracts').where({ id }).first();
    const fullySignedMails = async () => (await db('email_queue').where({ email_type: 'contract_fully_signed' }))
      .map((row) => (typeof row.email_data === 'string' ? JSON.parse(row.email_data) : row.email_data))
      .filter((data) => data.contract_number === contractNumber);

    const realStamp = pdfStampService.stampSignature;
    const realStamps = pdfStampService.stampSignatures;
    let restampRun;
    let markRestampRendering;
    const restampRendering = new Promise((resolve) => { markRestampRendering = resolve; });
    let releaseRestamp;
    const restampReleased = new Promise((resolve) => { releaseRestamp = resolve; });
    const many = jest.spyOn(pdfStampService, 'stampSignatures').mockImplementationOnce(async (...args) => {
      markRestampRendering();
      await restampReleased;
      return realStamps.apply(pdfStampService, args);
    });
    const one = jest.spyOn(pdfStampService, 'stampSignature').mockImplementationOnce(async (args) => {
      // Another admin re-stamps the customer signature while the
      // countersignature renders; the re-stamp's PDF is still rendering when
      // the countersignature's stamp is refused.
      restampRun = contractService.restampSignatures(id, { customerSignatureDataUrl: SIGNATURE_DATA_URL }, adminId);
      restampRun.catch(() => {});
      await Promise.race([restampRendering, restampRun]);
      return realStamp.call(pdfStampService, args);
    });
    try {
      await contractService.recordAdminCountersignature(
        id, { name: 'Admin', ip: '203.0.113.33', signatureDataUrl: SIGNATURE_DATA_URL }, adminId,
      );
      const deferred = await db('contracts').where({ id }).first();
      expect(deferred.status).toBe('fully_signed');
      expect(deferred.signed_pdf_render_failed_at).toBeTruthy();
      expect(await fullySignedMails()).toHaveLength(0);

      releaseRestamp();
      await restampRun;
    } finally {
      releaseRestamp();
      one.mockRestore();
      many.mockRestore();
    }

    // The re-stamp recorded its PDF but sends nothing, so the marker stays
    // until the admin re-sends.
    const restamped = await db('contracts').where({ id }).first();
    expect(restamped.signed_pdf_path).not.toBe(customerOnly);
    expect(restamped.signed_pdf_render_failed_at).toBeTruthy();
    expect(await fullySignedMails()).toHaveLength(0);

    await contractService.rerenderAndResend(id, adminId);
    const resent = await db('contracts').where({ id }).first();
    expect(resent.signed_pdf_render_failed_at).toBeFalsy();
    const mails = await fullySignedMails();
    expect(mails.length).toBeGreaterThan(0);
    for (const mail of mails) {
      expect(mail.attachments.find((a) => a.filename === `${contractNumber}-signed.pdf`).contentPath)
        .toBe(resent.signed_pdf_path);
    }
  });

  it('marks the render failed instead of recording a PDF without the countersignature', async () => {
    const { id, token } = await sentContract('Unstampable countersign');
    await contractService.recordCustomerSignature({
      token, name: 'Maria Meier', accepted: true, ip: '198.51.100.13', signatureDataUrl: SIGNATURE_DATA_URL,
    });
    const customerStamped = (await db('contracts').where({ id }).first()).signed_pdf_path;

    // Valid base64 in a PNG data URL, but not an image the PDF can embed.
    await contractService.recordAdminCountersignature(
      id, { name: 'Admin', ip: '203.0.113.31', signatureDataUrl: 'data:image/png;base64,YmFk' }, adminId,
    );

    const contract = await db('contracts').where({ id }).first();
    expect(contract.status).toBe('fully_signed');
    expect(contract.signed_pdf_render_failed_at).toBeTruthy();
    expect(contract.signed_pdf_path).toBe(customerStamped);
  });

  it('does not replace a wet-signed upload that landed right after the countersignature took the status', async () => {
    const { id, token } = await sentContract('Upload before countersign stamp');
    await contractService.recordCustomerSignature({
      token, name: 'Maria Meier', accepted: true, ip: '198.51.100.14', signatureDataUrl: SIGNATURE_DATA_URL,
    });
    const uploadDir = path.join(process.env.STORAGE_PATH, 'uploads', 'contracts', 'signed');
    fs.mkdirSync(uploadDir, { recursive: true });
    const wet = path.join(uploadDir, `wet-countersign-${Date.now()}.pdf`);
    fs.writeFileSync(wet, '%PDF-1.4 authoritative wet-signed copy');

    mockBeforeContractRead = { contractId: id, run: () => contractService.attachSignedPdfUpload(id, wet, 'customer') };
    try {
      await contractService.recordAdminCountersignature(
        id, { name: 'Admin', ip: '203.0.113.32', signatureDataUrl: SIGNATURE_DATA_URL }, adminId,
      );
    } finally {
      mockBeforeContractRead = null;
    }

    const contract = await db('contracts').where({ id }).first();
    expect(contract.status).toBe('fully_signed');
    expect(contract.signed_admin_name).toBe('Admin');
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
    // The image was replaced even though the PDF was not, so the audit trail
    // still records the re-stamp.
    expect(await restampLogsFor(id)).toEqual([expect.objectContaining({ superseded: true })]);
  });

  it('does not record a re-stamp whose signature image another re-stamp replaced while it rendered', async () => {
    const id = await customerSigned('Overlapping restamps');
    const imageA = await pngDataUrl({ r: 200, g: 0, b: 0 });
    const imageB = await pngDataUrl({ r: 0, g: 0, b: 200 });
    const recorder = recordStamps();
    let bRun;
    let markBRendering;
    const bRendering = new Promise((resolve) => { markBRendering = resolve; });
    let releaseB;
    const aFinished = new Promise((resolve) => { releaseB = resolve; });
    recorder.many
      .mockImplementationOnce(async (buffer, stamps) => {
        // Re-stamp B starts after A replaced the image, while A renders.
        bRun = contractService.restampSignatures(id, { customerSignatureDataUrl: imageB }, adminId);
        await Promise.race([bRendering, bRun]);
        return recorder.recordMany(buffer, stamps);
      })
      .mockImplementationOnce(async (buffer, stamps) => {
        markBRendering();
        // B is still rendering when A finishes.
        await aFinished;
        return recorder.recordMany(buffer, stamps);
      });
    let a;
    let b;
    try {
      a = await contractService.restampSignatures(id, { customerSignatureDataUrl: imageA }, adminId);
      releaseB();
      b = await bRun;
    } finally {
      releaseB();
      recorder.restore();
    }

    const contract = await db('contracts').where({ id }).first();
    // The PDF on record carries the image the contract references.
    expect(recorder.stampsOf(contract.signed_pdf_sha256).map((stamp) => stamp.png))
      .toEqual([contract.signed_customer_signature_path]);
    expect(a.superseded).toBe(true);
    expect(b.superseded).toBeUndefined();
    expect(await restampLogsFor(id)).toHaveLength(2);
  });

  it('does not let a re-stamp replace the image behind a PDF recorded after it read the contract', async () => {
    const id = await customerSigned('Restamp after record');
    const imageA = await pngDataUrl({ r: 0, g: 160, b: 0 });
    const imageB = await pngDataUrl({ r: 160, g: 0, b: 160 });
    // Warm the column checks so A records its PDF in the same few ticks it
    // takes B to read the contract, without a schema query in between.
    const { hasColumnCached } = require('../../src/utils/schemaCache');
    for (const column of ['signed_pdf_is_wet_upload', 'signed_pdf_sha256', 'signed_pdf_render_failed_at']) {
      await hasColumnCached('contracts', column);
    }
    const recorder = recordStamps();
    let bRun;
    recorder.many.mockImplementationOnce(async (buffer, stamps) => {
      const out = await recorder.recordMany(buffer, stamps);
      // B reads the contract before A records this PDF, and replaces the
      // image after.
      bRun = contractService.restampSignatures(id, { customerSignatureDataUrl: imageB }, adminId);
      bRun.catch(() => {});
      return out;
    });
    let b;
    try {
      await contractService.restampSignatures(id, { customerSignatureDataUrl: imageA }, adminId);
      b = await Promise.allSettled([bRun]).then(([settled]) => settled);
    } finally {
      recorder.restore();
    }

    const contract = await db('contracts').where({ id }).first();
    expect(recorder.stampsOf(contract.signed_pdf_sha256).map((stamp) => stamp.png))
      .toEqual([contract.signed_customer_signature_path]);
    if (b.status === 'rejected') expect(b.reason.code).toBe('CONTRACT_STATE_CHANGED');
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

  async function fullySignedWithImages(title) {
    const { id, token } = await sentContract(title);
    await contractService.recordCustomerSignature({
      token, name: 'Maria Meier', accepted: true, ip: '198.51.100.21', signatureDataUrl: SIGNATURE_DATA_URL,
    });
    await contractService.recordAdminCountersignature(
      id, { name: 'Admin', ip: '203.0.113.21', signatureDataUrl: SIGNATURE_DATA_URL }, adminId,
    );
    const contract = await db('contracts').where({ id }).first();
    expect(contract.signed_pdf_render_failed_at).toBeFalsy();
    return contract;
  }

  it('refuses a re-stamp whose signature cannot be stamped and records no PDF', async () => {
    // A countersignature takes a PDF a re-stamp recorded after it as the fully
    // signed copy to mail, so an incomplete re-stamp must never be recorded.
    const before = await fullySignedWithImages('Unstampable restamp');

    await expect(contractService.restampSignatures(
      before.id, { adminSignatureDataUrl: 'data:image/png;base64,YmFk' }, adminId,
    )).rejects.toMatchObject({ statusCode: 422, code: 'SIGNATURE_STAMP_FAILED' });

    const contract = await db('contracts').where({ id: before.id }).first();
    expect(contract.signed_pdf_path).toBe(before.signed_pdf_path);
    expect(contract.signed_pdf_render_failed_at).toBeTruthy();
    expect(await restampLogsFor(before.id)).toEqual([expect.objectContaining({ stampFailed: ['admin'] })]);
  });

  it('refuses a re-send when a signature on record cannot be stamped, and mails nothing', async () => {
    const before = await fullySignedWithImages('Unstampable resend');
    fs.writeFileSync(before.signed_admin_signature_path, 'not an image');
    const mailsBefore = (await db('email_queue').where({ email_type: 'contract_fully_signed' })).length;

    await expect(contractService.rerenderAndResend(before.id, adminId))
      .rejects.toMatchObject({ statusCode: 422, code: 'SIGNATURE_STAMP_FAILED' });

    const contract = await db('contracts').where({ id: before.id }).first();
    expect(contract.signed_pdf_path).toBe(before.signed_pdf_path);
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
