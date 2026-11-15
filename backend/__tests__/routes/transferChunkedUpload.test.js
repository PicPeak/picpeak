'use strict';

/**
 * PicTransfer files too large for one request go up in chunks.
 *
 * Behind Cloudflare (Free/Pro: 100 MB per request body) a 500 MB deliverable
 * in one multipart POST never arrives. Both transfer upload surfaces now take
 * one large file as init / chunk / complete through the shared chunk service,
 * and complete accepts it exactly as the multipart route does: the same type
 * and size rules, the same storage write and row, the same side effects.
 *
 * Covered here: the admin deliverable upload into a send and the public
 * file-request upload — the stored bytes, ownership (an upload id is a 404
 * from any other transfer, admin or link), type and size refusals, the link
 * checks on every chunk route, the public allowances and abort cleanup.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'transfer-chunked-test-secret-32-chars!!';

const mockSendTemplateEmail = jest.fn(async () => true);
jest.mock('../../src/services/emailProcessor', () => ({
  ...jest.requireActual('../../src/services/emailProcessor'),
  sendTemplateEmail: (...args) => mockSendTemplateEmail(...args),
}));

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcrypt');
const request = require('supertest');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp,
} = require('../integration/helpers/crmDb');

jest.setTimeout(120000);

const CHUNK = 10 * 1024 * 1024;
let db; let cleanup; let admin; let pub;
let ownerId; let ownerToken; let otherToken;
let seq = 0;
let ip = 0;

const unwrap = (rows) => (typeof rows[0] === 'object' && rows[0] !== null ? rows[0].id : rows[0]);
const nextIp = () => { ip += 1; return `10.9.${Math.floor(ip / 250)}.${ip % 250}`; };
const future = () => new Date(Date.now() + 864e5).toISOString();

async function createAdmin(username, role) {
  const id = unwrap(await db('admin_users').insert({
    username, email: `${username}@example.com`, password_hash: await bcrypt.hash('pw', 4),
    is_active: 1, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }).returning('id'));
  await assignAdminRole(db, id, role);
  return id;
}

async function createTransfer(kind, createdBy, extra = {}) {
  seq += 1;
  const token = crypto.randomBytes(32).toString('hex');
  const id = unwrap(await db('transfers').insert({
    token, kind, title: `${kind} ${seq}`, expires_at: future(), is_active: true, grace_days: 7,
    allow_uploads: kind === 'request', created_by: createdBy,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...extra,
  }).returning('id'));
  return { id, token };
}

async function setSetting(key, value) {
  await db('app_settings').where({ setting_key: key }).del();
  if (value !== undefined) await db('app_settings').insert({ setting_key: key, setting_value: JSON.stringify(value) });
}

const storedBytes = (key) => fs.readFileSync(require('../../src/services/storage').getStorage().resolveLocalPath(key));
// Admissions still held for one transfer (an upload refused on a deleted link
// can only be released by the idle sweep, so counts are per transfer).
const activeAdmissions = async (transferId) => Number((await db('public_upload_requests')
  .where({ active: 1, transfer_id: transferId }).count('* as c').first()).c);
const stagingDir = (requestId) => path.join(process.env.STORAGE_PATH, 'temp', 'public-uploads', requestId);
const admissionIds = async (transferId) => (await db('public_upload_requests').where({ transfer_id: transferId }).select('id'))
  .map((row) => row.id);

// --- admin helpers ---
const adminInit = (token, id, body) => request(admin).post(`/api/admin/transfers/${id}/chunked-upload/init`)
  .set('Authorization', `Bearer ${token}`).send(body);
const adminChunk = (token, id, uploadId, index, bytes) => request(admin)
  .post(`/api/admin/transfers/${id}/chunked-upload/${uploadId}/chunk/${index}`)
  .set('Authorization', `Bearer ${token}`).set('Content-Type', 'application/octet-stream').send(bytes);
const adminComplete = (token, id, uploadId) => request(admin)
  .post(`/api/admin/transfers/${id}/chunked-upload/${uploadId}/complete`)
  .set('Authorization', `Bearer ${token}`).send({});
const adminAbort = (token, id, uploadId) => request(admin)
  .delete(`/api/admin/transfers/${id}/chunked-upload/${uploadId}`).set('Authorization', `Bearer ${token}`);

async function adminUpload(token, id, bytes, name = 'film.zip') {
  const init = await adminInit(token, id, { filename: name, fileSize: bytes.length, mimeType: 'application/zip' });
  expect(init.status).toBe(200);
  for (let i = 0; i < init.body.expectedChunks; i += 1) {
    const res = await adminChunk(token, id, init.body.uploadId, i, bytes.subarray(i * CHUNK, (i + 1) * CHUNK));
    expect(res.status).toBe(200);
  }
  return adminComplete(token, id, init.body.uploadId);
}

// --- public helpers ---
const pubInit = (token, body) => request(pub).post(`/api/public/transfer-upload/${token}/chunked-upload/init`)
  .set('X-Forwarded-For', nextIp()).send(body);
const pubChunk = (token, uploadId, index, bytes) => request(pub)
  .post(`/api/public/transfer-upload/${token}/chunked-upload/${uploadId}/chunk/${index}`)
  .set('Content-Type', 'application/octet-stream').send(bytes);
const pubComplete = (token, uploadId) => request(pub)
  .post(`/api/public/transfer-upload/${token}/chunked-upload/${uploadId}/complete`).send({});
const pubAbort = (token, uploadId) => request(pub).delete(`/api/public/transfer-upload/${token}/chunked-upload/${uploadId}`);

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  const seeded = await seedMinimal(db);
  await assignAdminRole(db, seeded.adminId, 'super_admin');
  ownerId = await createAdmin('transfer-chunk-owner', 'admin');
  const otherId = await createAdmin('transfer-chunk-other', 'admin');
  ownerToken = mintAdminToken(ownerId);
  otherToken = mintAdminToken(otherId);
  const flag = await db('feature_flags').where({ key: 'transfers' }).first();
  if (flag) await db('feature_flags').where({ key: 'transfers' }).update({ value: true });
  else await db('feature_flags').insert({ key: 'transfers', value: true });
  // Under jest a service's `new Date()` binds as a foreign-realm Date that
  // node-sqlite3 stringifies; normalise bindings as the other transfer suites do.
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
  admin = buildRouteApp('/api/admin/transfers', require('../../src/routes/adminTransfers'));
  pub = buildRouteApp('/api/public/transfer-upload', require('../../src/routes/publicTransferUpload'));
}, 180000);

afterEach(async () => {
  jest.restoreAllMocks();
  mockSendTemplateEmail.mockClear();
  delete process.env.PUBLIC_UPLOAD_LIMITS_JSON;
  await setSetting('transfer_max_upload_size_mb', undefined);
  await setSetting('transfer_upload_accept_all', undefined);
});

afterAll(async () => { if (cleanup) await cleanup(); });

describe('admin deliverable upload in chunks', () => {
  it('merges the chunks into one deliverable file, stored byte for byte', async () => {
    const send = await createTransfer('send', ownerId);
    // Two chunks: a full 10 MB part and a remainder.
    const bytes = crypto.randomBytes(CHUNK + 4096);
    const res = await adminUpload(ownerToken, send.id, bytes, 'Hochzeit Film.zip');

    expect(res.status).toBe(200);
    const rows = await db('transfer_extra_files').where({ transfer_id: send.id });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ original_filename: 'Hochzeit Film.zip', mime_type: 'application/zip' });
    expect(Number(rows[0].size_bytes)).toBe(bytes.length);
    expect(storedBytes(rows[0].stored_path).equals(bytes)).toBe(true);
    expect(res.body.transfer.extra_files).toHaveLength(1);
    expect(await activeAdmissions(send.id)).toBe(0);
  });

  it('merges under an opaque name, so a long valid name cannot fail the merge', async () => {
    // 100 CJK characters are 300 UTF-8 bytes: over the 255-byte name limit of
    // ext4 and most Linux filesystems, which only failed after the last chunk.
    const chunkedUpload = require('../../src/services/chunkedUploadService');
    const merged = [];
    const real = chunkedUpload.completeUpload;
    jest.spyOn(chunkedUpload, 'completeUpload').mockImplementation(async (...args) => {
      const result = await real(...args);
      merged.push(result.path);
      return result;
    });
    const send = await createTransfer('send', ownerId);
    const name = `${'婚'.repeat(100)}.pdf`;
    expect(Buffer.byteLength(name)).toBeGreaterThan(255);
    const res = await adminUpload(ownerToken, send.id, Buffer.from('%PDF long'), name);
    expect(res.status).toBe(200);
    expect(path.basename(merged[0])).toBe('merged.bin');
    const [row] = await db('transfer_extra_files').where({ transfer_id: send.id });
    expect(row.original_filename).toBe(name);

    const req = await createTransfer('request', ownerId);
    const bytes = Buffer.from('%PDF long');
    const init = await pubInit(req.token, { filename: name, fileSize: bytes.length });
    await pubChunk(req.token, init.body.uploadId, 0, bytes);
    expect((await pubComplete(req.token, init.body.uploadId)).status).toBe(201);
    expect(path.basename(merged[1])).toBe('merged.bin');
    expect((await db('transfer_uploads').where({ transfer_id: req.id }).first()).original_filename).toBe(name);
  });

  it('answers success for a stored file when the transfer cannot be re-read', async () => {
    // The page would otherwise report the file missing, and a re-upload
    // would store it twice.
    const transferService = require('../../src/services/transferService');
    const real = transferService.getTransfer;
    // The nth read is the one after the store (init and complete each read once before).
    const failAfterStore = (nth) => {
      let calls = 0;
      jest.spyOn(transferService, 'getTransfer').mockImplementation(async (id) => {
        calls += 1;
        if (calls === nth) throw new Error('database gone');
        return real(id);
      });
    };
    const send = await createTransfer('send', ownerId);
    failAfterStore(3);
    const chunked = await adminUpload(ownerToken, send.id, Buffer.from('%PDF stored'), 'stored.pdf');
    expect(chunked.status).toBe(200);
    jest.restoreAllMocks();

    failAfterStore(2);
    const multipart = await request(admin).post(`/api/admin/transfers/${send.id}/upload-files`)
      .set('Authorization', `Bearer ${ownerToken}`).attach('files', Buffer.from('%PDF small'), 'small.pdf');
    expect(multipart.status).toBe(200);
    expect(await db('transfer_extra_files').where({ transfer_id: send.id })).toHaveLength(2);
  });

  it('reports a multipart file whose row could not be written, and errors when none landed', async () => {
    const transferService = require('../../src/services/transferService');
    const real = transferService.addExtraFile;
    jest.spyOn(transferService, 'addExtraFile').mockImplementation(async (id, file) => {
      if (file.originalFilename === 'broken.pdf') throw new Error('database gone');
      return real(id, file);
    });
    const send = await createTransfer('send', ownerId);
    const upload = (...names) => {
      let req = request(admin).post(`/api/admin/transfers/${send.id}/upload-files`).set('Authorization', `Bearer ${ownerToken}`);
      for (const name of names) req = req.attach('files', Buffer.from('%PDF x'), name);
      return req;
    };
    const some = await upload('fine.pdf', 'broken.pdf');
    expect(some.status).toBe(200);
    expect(some.body.failed_files).toEqual(['broken.pdf']);
    const none = await upload('broken.pdf');
    expect(none.status).toBe(500);
    expect(none.body).toMatchObject({ code: 'STORE_FAILED', failed_files: ['broken.pdf'] });
    expect(await db('transfer_extra_files').where({ transfer_id: send.id })).toHaveLength(1);

    const created = await request(admin).post('/api/admin/transfers').set('Authorization', `Bearer ${ownerToken}`)
      .field('title', 'Partly').field('photoIds', '[]').attach('files', Buffer.from('%PDF x'), 'fine.pdf')
      .attach('files', Buffer.from('%PDF x'), 'broken.pdf');
    expect(created.status).toBe(201);
    expect(created.body.failed_files).toEqual(['broken.pdf']);
  });

  it('answers 404 to another admin, another transfer and a public link', async () => {
    const send = await createTransfer('send', ownerId);
    const second = await createTransfer('send', ownerId);
    const request_ = await createTransfer('request', ownerId);
    const bytes = Buffer.from('PK deliverable bytes');
    const init = await adminInit(ownerToken, send.id, { filename: 'a.zip', fileSize: bytes.length });
    const { uploadId } = init.body;

    // Another admin cannot reach the transfer at all.
    expect((await adminChunk(otherToken, send.id, uploadId, 0, bytes)).status).toBe(404);
    expect((await adminComplete(otherToken, send.id, uploadId)).status).toBe(404);
    expect((await adminAbort(otherToken, send.id, uploadId)).status).toBe(404);
    // The same admin, on a transfer the upload was not started for.
    expect((await adminChunk(ownerToken, second.id, uploadId, 0, bytes)).status).toBe(404);
    expect((await adminComplete(ownerToken, second.id, uploadId)).status).toBe(404);
    expect((await adminAbort(ownerToken, second.id, uploadId)).status).toBe(404);
    // A public link, even one of the same admin's requests.
    expect((await pubChunk(request_.token, uploadId, 0, bytes)).status).toBe(404);
    expect((await pubAbort(request_.token, uploadId)).status).toBe(404);

    // The upload itself is untouched and still completes where it belongs.
    expect((await adminChunk(ownerToken, send.id, uploadId, 0, bytes)).status).toBe(200);
    expect((await adminComplete(ownerToken, send.id, uploadId)).status).toBe(200);
    expect(await db('transfer_extra_files').where({ transfer_id: second.id })).toHaveLength(0);
    expect(await db('transfer_extra_files').where({ transfer_id: send.id })).toHaveLength(1);
  });

  it('refuses a type the transfer policy does not allow, before any byte', async () => {
    const send = await createTransfer('send', ownerId);
    const res = await adminInit(ownerToken, send.id, { filename: 'setup.exe', fileSize: 1024, mimeType: 'application/x-msdownload' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'TYPE_REJECTED', rejected_files: ['setup.exe'] });
    expect(await activeAdmissions(send.id)).toBe(0);
  });

  it('holds the per-file cap on the declared size and on the bytes actually sent', async () => {
    await setSetting('transfer_max_upload_size_mb', 1);
    const send = await createTransfer('send', ownerId);
    const tooBig = await adminInit(ownerToken, send.id, { filename: 'big.zip', fileSize: 2 * 1024 * 1024 });
    expect(tooBig.status).toBe(413);

    // Declared small, sent past the cap: refused, and the upload is over.
    const liar = await adminInit(ownerToken, send.id, { filename: 'liar.zip', fileSize: 100 });
    const over = await adminChunk(ownerToken, send.id, liar.body.uploadId, 0, crypto.randomBytes(2 * 1024 * 1024));
    expect(over.status).toBe(413);
    expect((await adminComplete(ownerToken, send.id, liar.body.uploadId)).status).toBe(404);

    // Declared small, sent larger but under the cap: refused at its size.
    const init = await adminInit(ownerToken, send.id, { filename: 'short.zip', fileSize: 100 });
    const res = await adminChunk(ownerToken, send.id, init.body.uploadId, 0, crypto.randomBytes(200));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_CHUNK');
    expect((await adminComplete(ownerToken, send.id, init.body.uploadId)).status).toBe(400);
    expect(await db('transfer_extra_files').where({ transfer_id: send.id })).toHaveLength(0);
    await adminAbort(ownerToken, send.id, init.body.uploadId);
    expect(await activeAdmissions(send.id)).toBe(0);
  });

  it('refuses a file request, which sends nothing out', async () => {
    const req = await createTransfer('request', ownerId);
    const res = await adminInit(ownerToken, req.id, { filename: 'a.zip', fileSize: 10 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('NOT_A_SEND');
  });

  it('aborts: the staging and the admission go, and the id is gone', async () => {
    const send = await createTransfer('send', ownerId);
    const bytes = crypto.randomBytes(CHUNK + 10);
    const init = await adminInit(ownerToken, send.id, { filename: 'a.zip', fileSize: bytes.length });
    expect((await adminChunk(ownerToken, send.id, init.body.uploadId, 0, bytes.subarray(0, CHUNK))).status).toBe(200);
    const [held] = await admissionIds(send.id);
    expect(fs.existsSync(stagingDir(held))).toBe(true);

    expect((await adminAbort(ownerToken, send.id, init.body.uploadId)).status).toBe(200);
    expect(fs.existsSync(stagingDir(held))).toBe(false);
    expect(await activeAdmissions(send.id)).toBe(0);
    expect((await adminChunk(ownerToken, send.id, init.body.uploadId, 1, bytes.subarray(CHUNK))).status).toBe(404);
  });
});

describe('creating a send whose files follow in chunks', () => {
  const create = (fields) => {
    let req = request(admin).post('/api/admin/transfers').set('Authorization', `Bearer ${ownerToken}`)
      .field('kind', 'send').field('title', 'Wedding film');
    for (const [key, value] of Object.entries(fields)) req = req.field(key, String(value));
    return req;
  };

  it('creates a send with only pending files, and holds its mail until they landed', async () => {
    const res = await create({
      pendingFiles: 1, deliveryMethod: 'email', recipientEmails: JSON.stringify(['client@example.com']), photoIds: '[]',
    });
    expect(res.status).toBe(201);
    const { id } = res.body.transfer;
    expect(mockSendTemplateEmail).not.toHaveBeenCalled();
    expect(res.body.transfer.recipients).toEqual([expect.objectContaining({ email: 'client@example.com', held: true })]);

    // The file lands: still no mail, and no automatic path (a photo of the
    // send finishing processing ends up here) sends it either.
    const done = await adminUpload(ownerToken, id, Buffer.from('PK film'), 'film.zip');
    expect(done.status).toBe(200);
    const transferService = require('../../src/services/transferService');
    expect((await transferService.sendHeldReadyEmails(id)).sent).toBe(0);
    expect(mockSendTemplateEmail).not.toHaveBeenCalled();

    // The page sends it once everything is in, exactly once.
    const resend = await request(admin).post(`/api/admin/transfers/${id}/resend`).set('Authorization', `Bearer ${ownerToken}`).send({});
    expect(resend.status).toBe(200);
    expect(mockSendTemplateEmail).toHaveBeenCalledTimes(1);
    expect(mockSendTemplateEmail.mock.calls[0][0]).toBe('client@example.com');
    expect(mockSendTemplateEmail.mock.calls[0][2]).toMatchObject({ file_count: '1' });
    await transferService.sendHeldReadyEmails(id);
    expect(mockSendTemplateEmail).toHaveBeenCalledTimes(1);
    expect((await db('transfers').where({ id }).first()).delivery_held_until).toBeNull();
  });

  it('puts the hold on before any held recipient exists', async () => {
    // A photo finishing between the two writes would find a held recipient
    // without a hold and mail it ahead of the files.
    const order = [];
    const listener = (query) => {
      if (/insert into .transfer_recipients./i.test(query.sql)) order.push('recipient');
      if (/update .transfers. set .delivery_held_until./i.test(query.sql)) order.push('hold');
    };
    db.on('query', listener);
    try {
      const res = await create({
        pendingFiles: 1, deliveryMethod: 'email', recipientEmails: JSON.stringify(['first@example.com']), photoIds: '[]',
      });
      expect(res.status).toBe(201);
    } finally {
      db.removeListener('query', listener);
    }
    expect(order).toEqual(['hold', 'recipient']);
  });

  it('reads the recipients before it lifts the hold on resend', async () => {
    // Lifted first, a photo finishing in between could claim and mail a held
    // recipient, which the snapshot then shows as sent and mails again.
    const { id } = (await create({
      pendingFiles: 1, deliveryMethod: 'email', recipientEmails: JSON.stringify(['order@example.com']), photoIds: '[]',
    })).body.transfer;
    await adminUpload(ownerToken, id, Buffer.from('PK film'));
    const order = [];
    const listener = (query) => {
      if (/from .transfer_recipients. where .* .email. in/i.test(query.sql)) order.push('snapshot');
      if (/update .transfers. set .delivery_held_until./i.test(query.sql)) order.push('lift');
    };
    db.on('query', listener);
    try {
      expect((await request(admin).post(`/api/admin/transfers/${id}/resend`).set('Authorization', `Bearer ${ownerToken}`).send({})).status).toBe(200);
    } finally {
      db.removeListener('query', listener);
    }
    expect(order.slice(0, 2)).toEqual(['snapshot', 'lift']);
    expect(mockSendTemplateEmail).toHaveBeenCalledTimes(1);
  });

  it('lets a hold the page never finished lapse, so the recipients are not stranded', async () => {
    const res = await create({
      pendingFiles: 1, deliveryMethod: 'email', recipientEmails: JSON.stringify(['stranded@example.com']), photoIds: '[]',
    });
    const { id } = res.body.transfer;
    await adminUpload(ownerToken, id, Buffer.from('PK film'));
    expect(mockSendTemplateEmail).not.toHaveBeenCalled();
    await db('transfers').where({ id }).update({ delivery_held_until: Date.now() - 1000 });

    expect((await require('../../src/services/transferService').sendHeldReadyEmails(id)).sent).toBe(1);
    expect(mockSendTemplateEmail).toHaveBeenCalledWith('stranded@example.com', 'transfer_ready', expect.anything());
  });

  it('answers a multipart write only once its admission is released', async () => {
    // The page sends the next request (a chunked file) on this answer; with
    // one admission slot per admin it would otherwise be refused as busy.
    const uploadQuota = require('../../src/services/publicUploadQuota');
    const realFinish = uploadQuota.finish;
    let released = false;
    jest.spyOn(uploadQuota, 'finish').mockImplementation(async (session, options) => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      const result = await realFinish(session, options);
      released = true;
      return result;
    });
    const res = await create({ photoIds: '[]' }).attach('files', Buffer.from('PK small'), 'small.zip');
    expect(res.status).toBe(201);
    expect(released).toBe(true);
  });

  it('still refuses an empty send when nothing is pending', async () => {
    const res = await create({ photoIds: '[]' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('NOTHING_TO_SEND');
  });

  it('still sends a mail held for want of files when a chunked file lands', async () => {
    // Held because nothing was downloadable (issue 2061), not by a pending
    // upload: the first file that lands sends it, as upload-files does.
    const send = await createTransfer('send', ownerId);
    await require('../../src/services/transferService').sendTransferEmails(send.id, ['late@example.com']);
    expect(mockSendTemplateEmail).not.toHaveBeenCalled();
    const done = await adminUpload(ownerToken, send.id, Buffer.from('PK film'));
    expect(done.status).toBe(200);
    expect(mockSendTemplateEmail).toHaveBeenCalledTimes(1);
    expect(done.body.transfer.recipients[0].held).toBe(false);
  });
});

describe('public file-request upload in chunks', () => {
  it('stores the merged file as the request upload and notifies the admin once', async () => {
    const transferService = require('../../src/services/transferService');
    const notify = jest.spyOn(transferService, 'notifyFilesReceived');
    const req = await createTransfer('request', ownerId);
    const bytes = crypto.randomBytes(CHUNK + 77);
    const init = await pubInit(req.token, { filename: 'RAW Export.zip', fileSize: bytes.length, mimeType: 'application/zip' });
    expect(init.status).toBe(200);
    expect(init.body.expectedChunks).toBe(2);
    for (let i = 0; i < 2; i += 1) {
      expect((await pubChunk(req.token, init.body.uploadId, i, bytes.subarray(i * CHUNK, (i + 1) * CHUNK))).status).toBe(200);
    }
    const res = await pubComplete(req.token, init.body.uploadId);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ uploaded: 1, failed_files: [], rejected_files: [] });
    const rows = await db('transfer_uploads').where({ transfer_id: req.id });
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].size_bytes)).toBe(bytes.length);
    expect(storedBytes(rows[0].stored_path).equals(bytes)).toBe(true);
    // Charged to the request like a multipart file.
    const charge = await db('public_upload_objects').where({ reference_type: 'transfer', reference_id: rows[0].id }).first();
    expect(charge).toMatchObject({ transfer_id: req.id, state: 'stored' });
    expect(Number(charge.bytes)).toBe(bytes.length);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(req.id, 1);
    expect(await activeAdmissions(req.id)).toBe(0);
  });

  it.each([
    ['expired', 410, 'UPLOAD_EXPIRED', { expires_at: new Date(Date.now() - 1000).toISOString() }],
    ['closed', 403, 'UPLOADS_DISABLED', { is_active: false }],
    ['deleted', 404, 'NOT_FOUND', { deleted_at: new Date().toISOString() }],
  ])('refuses every chunk route on a link that was %s mid-upload', async (_what, status, code, change) => {
    const req = await createTransfer('request', ownerId);
    const bytes = crypto.randomBytes(CHUNK + 1);
    const init = await pubInit(req.token, { filename: 'a.zip', fileSize: bytes.length });
    expect((await pubChunk(req.token, init.body.uploadId, 0, bytes.subarray(0, CHUNK))).status).toBe(200);

    await db('transfers').where({ id: req.id }).update(change);
    const chunk = await pubChunk(req.token, init.body.uploadId, 1, bytes.subarray(CHUNK));
    expect(chunk.status).toBe(status);
    expect(chunk.body.code).toBe(code);
    const complete = await pubComplete(req.token, init.body.uploadId);
    expect(complete.status).toBe(status);
    expect((await pubInit(req.token, { filename: 'b.zip', fileSize: 10 })).status).toBe(status);
    expect(await db('transfer_uploads').where({ transfer_id: req.id })).toHaveLength(0);

    // Letting go still works on a closed link, and frees the admission.
    if (code !== 'NOT_FOUND') {
      expect((await pubAbort(req.token, init.body.uploadId)).status).toBe(200);
      expect(await activeAdmissions(req.id)).toBe(0);
    }
  });

  it('refuses the link closing while the merged file was waiting to be stored', async () => {
    const transferService = require('../../src/services/transferService');
    const req = await createTransfer('request', ownerId);
    const bytes = Buffer.from('%PDF-1.4 contract');
    const init = await pubInit(req.token, { filename: 'contract.pdf', fileSize: bytes.length });
    await pubChunk(req.token, init.body.uploadId, 0, bytes);
    // The guard of the complete request sees the live row; the re-read after
    // the merge sees it revoked.
    const real = transferService.getRequestByToken;
    let calls = 0;
    jest.spyOn(transferService, 'getRequestByToken').mockImplementation(async (token) => {
      calls += 1;
      if (calls === 2) await db('transfers').where({ id: req.id }).update({ is_active: false });
      return real(token);
    });
    const res = await pubComplete(req.token, init.body.uploadId);
    expect(res.status).toBe(403);
    expect(await db('transfer_uploads').where({ transfer_id: req.id })).toHaveLength(0);
    expect(await activeAdmissions(req.id)).toBe(0);
  });

  it('answers 404 from another request link and from the admin route', async () => {
    const req = await createTransfer('request', ownerId);
    const other = await createTransfer('request', ownerId);
    const send = await createTransfer('send', ownerId);
    const bytes = Buffer.from('%PDF-1.4 contract');
    const init = await pubInit(req.token, { filename: 'contract.pdf', fileSize: bytes.length });
    const { uploadId } = init.body;

    expect((await pubChunk(other.token, uploadId, 0, bytes)).status).toBe(404);
    expect((await pubComplete(other.token, uploadId)).status).toBe(404);
    expect((await pubAbort(other.token, uploadId)).status).toBe(404);
    expect((await adminChunk(ownerToken, send.id, uploadId, 0, bytes)).status).toBe(404);
    expect((await adminAbort(ownerToken, send.id, uploadId)).status).toBe(404);

    expect((await pubChunk(req.token, uploadId, 0, bytes)).status).toBe(200);
    expect((await pubComplete(req.token, uploadId)).status).toBe(201);
  });

  it('refuses a type the request does not accept, and one over the size cap', async () => {
    const req = await createTransfer('request', ownerId);
    const typed = await pubInit(req.token, { filename: 'run.exe', fileSize: 10, mimeType: 'application/x-msdownload' });
    expect(typed.status).toBe(400);
    expect(typed.body.code).toBe('TYPE_REJECTED');

    await setSetting('transfer_max_upload_size_mb', 1);
    expect((await pubInit(req.token, { filename: 'big.zip', fileSize: 2 * 1024 * 1024 })).status).toBe(413);
    const liar = await pubInit(req.token, { filename: 'liar.zip', fileSize: 50 });
    expect((await pubChunk(req.token, liar.body.uploadId, 0, crypto.randomBytes(1024 * 1024 + 1))).status).toBe(413);
    const init = await pubInit(req.token, { filename: 'short.zip', fileSize: 50 });
    const chunk = await pubChunk(req.token, init.body.uploadId, 0, crypto.randomBytes(51));
    expect(chunk.status).toBe(400);
    expect(chunk.body.code).toBe('INVALID_CHUNK');
    expect(await db('transfer_uploads').where({ transfer_id: req.id })).toHaveLength(0);
    await pubAbort(req.token, init.body.uploadId);
    expect(await activeAdmissions(req.id)).toBe(0);
  });

  it('holds each file to the request allowances: concurrency and lifetime', async () => {
    const req = await createTransfer('request', ownerId);
    process.env.PUBLIC_UPLOAD_LIMITS_JSON = JSON.stringify({ transfer: { requests: 1, files: 1 } });
    const first = await pubInit(req.token, { filename: 'a.pdf', fileSize: 8 });
    expect(first.status).toBe(200);
    // One upload in flight is the request's whole concurrency.
    const second = await pubInit(req.token, { filename: 'b.pdf', fileSize: 8 });
    expect(second.status).toBe(429);
    expect(second.body.code).toBe('UPLOAD_CONCURRENCY_LIMIT');

    await pubChunk(req.token, first.body.uploadId, 0, Buffer.from('%PDF-1.4'));
    expect((await pubComplete(req.token, first.body.uploadId)).status).toBe(201);
    // Its one lifetime file is used up.
    const third = await pubInit(req.token, { filename: 'c.pdf', fileSize: 8 });
    expect(third.status).toBe(429);
    expect(third.body.code).toBe('UPLOAD_LIFETIME_LIMIT');
  });

  it('aborts: the staging and the admission go, and the id is gone', async () => {
    const req = await createTransfer('request', ownerId);
    const bytes = crypto.randomBytes(CHUNK + 3);
    const init = await pubInit(req.token, { filename: 'a.zip', fileSize: bytes.length });
    await pubChunk(req.token, init.body.uploadId, 0, bytes.subarray(0, CHUNK));
    expect(await activeAdmissions(req.id)).toBe(1);
    const [held] = await admissionIds(req.id);
    expect(fs.existsSync(stagingDir(held))).toBe(true);

    expect((await pubAbort(req.token, init.body.uploadId)).status).toBe(200);
    expect(fs.existsSync(stagingDir(held))).toBe(false);
    expect(await activeAdmissions(req.id)).toBe(0);
    expect((await pubChunk(req.token, init.body.uploadId, 1, bytes.subarray(CHUNK))).status).toBe(404);
    expect((await pubAbort(req.token, init.body.uploadId)).status).toBe(404);
  });
});

describe('chunk count ceiling', () => {
  const chunkedUpload = require('../../src/services/chunkedUploadService');
  const GiB = 1024 * 1024 * 1024;

  it('follows a transfer cap above 10 GB, so an allowed 11 GB file fits', async () => {
    const result = await chunkedUpload.initializeUpload({
      filename: 'archive.zip', fileSize: 11 * GiB, transferId: 1, adminId: 1, maxFileSizeBytes: 12000 * 1024 * 1024,
    });
    expect(result.expectedChunks).toBe(Math.ceil((11 * GiB) / CHUNK));
    await chunkedUpload.abortUpload(result.uploadId);
  });

  it('keeps the 10 GB chunk limit for a caller with a lower cap or none', async () => {
    await expect(chunkedUpload.initializeUpload({ filename: 'a.mp4', fileSize: 11 * GiB, eventId: 1, adminId: 1 }))
      .rejects.toMatchObject({ code: 'INVALID_CHUNK' });
    await expect(chunkedUpload.initializeUpload({
      filename: 'a.mp4', fileSize: 11 * GiB, eventId: 1, adminId: 1, maxFileSizeBytes: 10 * GiB,
    })).rejects.toMatchObject({ code: 'INVALID_CHUNK' });
  });
});

describe('chunk body type', () => {
  it('guards both transfer chunk routes against a mislabelled body', async () => {
    const { requireOctetStreamChunk, CHUNK_ROUTE_PREFIXES } = require('../../src/middleware/chunkBodyType');
    const app = express();
    app.use(CHUNK_ROUTE_PREFIXES, requireOctetStreamChunk);
    app.use((req, res) => res.status(204).end());
    for (const url of ['/api/admin/transfers/1/chunked-upload/u/chunk/0', '/api/public/transfer-upload/abc/chunked-upload/u/chunk/0']) {
      const res = await request(app).post(url).set('Content-Type', 'application/json').send('{}');
      expect(res.status).toBe(415);
    }
  });
});
