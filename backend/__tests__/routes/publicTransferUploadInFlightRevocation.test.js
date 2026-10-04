'use strict';

/**
 * An upload that was still arriving when its transfer was revoked stores nothing.
 *
 * POST /public/transfer-upload/:token checked the transfer's eligibility once,
 * before multer read the body, and then stored the files on the strength of
 * that stale row. A large or slow upload could cross the upload expiry, or an
 * admin's disable or delete, and still land permanent objects and rows. The
 * route now reloads the row after the body is parsed and re-runs the same
 * predicate before anything becomes permanent; on refusal the temp files go.
 *
 * Stable shape: transfers carry a 6-char upload_token (no send/request split),
 * and assertUploadable reads deleted_at, allow_uploads and the upload expiry.
 *
 * The window is reproduced by letting the pre-body lookup return the live row
 * and committing the state change right behind it, before multer runs.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long!!';

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { bootCrmDb, buildRouteApp } = require('../integration/helpers/crmDb');

const TOKEN = 'UPLD7K';
const DOWNLOAD_TOKEN = 'd'.repeat(64);
let db; let cleanup; let app; let transferService; let transferId;

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  const flag = await db('feature_flags').where({ key: 'transfers' }).first();
  if (flag) await db('feature_flags').where({ key: 'transfers' }).update({ value: true });
  else await db('feature_flags').insert({ key: 'transfers', value: true });

  const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const inserted = await db('transfers').insert({
    token: DOWNLOAD_TOKEN, upload_token: TOKEN, title: 'Send your files', expires_at: future,
    is_active: true, grace_days: 7, allow_uploads: true, upload_expires_at: future,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }).returning('id');
  transferId = inserted[0]?.id ?? inserted[0];

  transferService = require('../../src/services/transferService');
  app = buildRouteApp('/api/public/transfer-upload', require('../../src/routes/publicTransferUpload'));
}, 120000);

afterEach(async () => {
  jest.restoreAllMocks();
  await db('transfers').where({ id: transferId }).update({
    is_active: true, allow_uploads: true, deleted_at: null,
    upload_expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  });
});
afterAll(async () => { if (cleanup) await cleanup(); });

const tempDir = () => path.join(process.env.STORAGE_PATH, 'temp', 'transfer-uploads');
const tempFiles = () => (fs.existsSync(tempDir()) ? fs.readdirSync(tempDir()) : []);
const upload = () => request(app)
  .post(`/api/public/transfer-upload/${TOKEN}`)
  .attach('files', Buffer.from('%PDF-1.4 bytes'), 'contract.pdf');

/** Pre-body lookup answers with the live row, then `change` commits behind it. */
function changeAfterGuard(change) {
  const real = transferService.getTransferByUploadToken;
  let first = true;
  jest.spyOn(transferService, 'getTransferByUploadToken').mockImplementation(async (token) => {
    const row = await real(token);
    if (first) { first = false; await change(); }
    return row;
  });
}

it('stores the files of a transfer that stays eligible', async () => {
  const res = await upload();
  expect(res.status).toBe(201);
  expect(await db('transfer_uploads').where({ transfer_id: transferId })).toHaveLength(1);
  await db('transfer_uploads').where({ transfer_id: transferId }).del();
});

it.each([
  ['expires', 410, 'UPLOAD_EXPIRED', () => db('transfers').where({ id: transferId })
    .update({ upload_expires_at: new Date(Date.now() - 1000).toISOString() })],
  ['stops taking uploads', 403, 'UPLOADS_DISABLED', () => db('transfers').where({ id: transferId })
    .update({ allow_uploads: false })],
  ['is deleted', 404, 'NOT_FOUND', () => db('transfers').where({ id: transferId })
    .update({ deleted_at: new Date().toISOString() })],
])('stores nothing when the transfer %s while the body is arriving', async (_what, status, code, change) => {
  const storage = require('../../src/services/storage').getStorage();
  const put = jest.spyOn(storage, 'putFromFile');
  changeAfterGuard(change);

  const res = await upload();

  expect(res.status).toBe(status);
  expect(res.body.code).toBe(code);
  expect(put).not.toHaveBeenCalled();
  expect(await db('transfer_uploads').where({ transfer_id: transferId })).toHaveLength(0);
  expect(tempFiles()).toHaveLength(0);
});

it('removes the uploaded files when the re-read of the request fails', async () => {
  // The body is on disk when the second lookup runs; a database error there
  // used to skip every cleanup loop and leave the temporary files behind.
  const storage = require('../../src/services/storage').getStorage();
  const put = jest.spyOn(storage, 'putFromFile');
  const real = transferService.getTransferByUploadToken;
  let first = true;
  jest.spyOn(transferService, 'getTransferByUploadToken').mockImplementation(async (token) => {
    if (first) { first = false; return real(token); }
    throw new Error('database gone');
  });

  const res = await upload();

  expect(res.status).toBe(500);
  expect(put).not.toHaveBeenCalled();
  expect(await db('transfer_uploads').where({ transfer_id: transferId })).toHaveLength(0);
  expect(tempFiles()).toHaveLength(0);
});
