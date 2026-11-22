'use strict';

/**
 * API v1 transfers (issue 2586): a photo booth integration creates a send,
 * uploads its files and mails the link with an API token, no admin login.
 *
 * The contract pinned here is that a token reaches exactly what its owner
 * reaches in the admin UI: the token's scope AND the owner's permission, the
 * `transfers` feature flag, and the ownership rule (a foreign transfer is a
 * 404, like a missing one). The upload limits are the admin upload's own.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'v1-transfers-test-secret-32-chars!!!';

const mockSendTemplateEmail = jest.fn(async () => true);
jest.mock('../../src/services/emailProcessor', () => ({
  ...jest.requireActual('../../src/services/emailProcessor'),
  sendTemplateEmail: (...args) => mockSendTemplateEmail(...args),
}));

const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const request = require('supertest');
const { bootCrmDb, seedMinimal, assignAdminRole, buildRouteApp } = require('../integration/helpers/crmDb');

jest.setTimeout(120000);

const CHUNK = 10 * 1024 * 1024;
let db; let cleanup; let app;
let ownerId; let otherId;
const tokens = {};

const unwrap = (rows) => (typeof rows[0] === 'object' && rows[0] !== null ? rows[0].id : rows[0]);

async function createAdmin(username, role) {
  const id = unwrap(await db('admin_users').insert({
    username, email: `${username}@example.com`, password_hash: await bcrypt.hash('pw', 4),
    is_active: 1, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }).returning('id'));
  await assignAdminRole(db, id, role);
  return id;
}

async function mintApiToken(adminId, scopes) {
  const generated = require('../../src/middleware/apiTokenAuth').generateApiToken();
  await db('api_tokens').insert({ name: `t-${scopes}-${adminId}`, hashed_token: generated.hashed, scopes, created_by: adminId });
  return generated.plaintext;
}

async function setSetting(key, value) {
  await db('app_settings').where({ setting_key: key }).del();
  if (value !== undefined) await db('app_settings').insert({ setting_key: key, setting_value: JSON.stringify(value) });
}

async function setTransfersFlag(value) {
  const flag = await db('feature_flags').where({ key: 'transfers' }).first();
  if (flag) await db('feature_flags').where({ key: 'transfers' }).update({ value });
  else await db('feature_flags').insert({ key: 'transfers', value });
  require('../../src/middleware/requireFeatureFlag').invalidateFeatureFlagCache();
}

const as = (token) => ({
  get: (url) => request(app).get(`/api/v1${url}`).set('Authorization', `Bearer ${token}`),
  post: (url) => request(app).post(`/api/v1${url}`).set('Authorization', `Bearer ${token}`),
  delete: (url) => request(app).delete(`/api/v1${url}`).set('Authorization', `Bearer ${token}`),
});

const storedBytes = (key) => fs.readFileSync(require('../../src/services/storage').getStorage().resolveLocalPath(key));

async function createSend(token, body = {}) {
  const res = await as(token).post('/transfers').send({ title: 'Booth handover', ...body });
  expect(res.status).toBe(201);
  return res.body.transfer;
}

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  const seeded = await seedMinimal(db);
  await assignAdminRole(db, seeded.adminId, 'super_admin');
  ownerId = await createAdmin('v1-transfer-owner', 'admin');
  otherId = await createAdmin('v1-transfer-other', 'admin');
  const viewerId = await createAdmin('v1-transfer-viewer', 'viewer');
  tokens.write = await mintApiToken(ownerId, 'write');
  tokens.read = await mintApiToken(ownerId, 'read');
  tokens.other = await mintApiToken(otherId, 'write');
  tokens.viewer = await mintApiToken(viewerId, 'write');
  tokens.superAdmin = await mintApiToken(seeded.adminId, 'write');
  await setTransfersFlag(true);
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
  app = buildRouteApp('/api/v1', require('../../src/routes/v1/transfers'));
}, 180000);

afterEach(async () => {
  jest.restoreAllMocks();
  mockSendTemplateEmail.mockClear();
  await setSetting('transfer_max_upload_size_mb', undefined);
  await setSetting('transfer_upload_accept_all', undefined);
  await setTransfersFlag(true);
});

afterAll(async () => { if (cleanup) await cleanup(); });

describe('auth model', () => {
  it('refuses a request without a token', async () => {
    expect((await request(app).get('/api/v1/transfers')).status).toBe(401);
  });

  it('lets a read token read but not write', async () => {
    expect((await as(tokens.read).get('/transfers')).status).toBe(200);
    const create = await as(tokens.read).post('/transfers').send({ title: 'nope' });
    expect(create.status).toBe(403);
    expect(create.body.code).toBe('INSUFFICIENT_SCOPE');
    const send = await createSend(tokens.write);
    const upload = await as(tokens.read).post(`/transfers/${send.id}/files`).attach('files', Buffer.from('%PDF x'), 'a.pdf');
    expect(upload.status).toBe(403);
    expect((await as(tokens.read).post(`/transfers/${send.id}/deliver`).send({})).status).toBe(403);
    expect((await as(tokens.read).post(`/transfers/${send.id}/chunked-upload/init`)
      .send({ filename: 'a.pdf', fileSize: 5 })).status).toBe(403);
  });

  it('refuses a write token whose owner lacks events.edit, whatever the scope says', async () => {
    const create = await as(tokens.viewer).post('/transfers').send({ title: 'viewer' });
    expect(create.status).toBe(403);
    expect(await db('transfers').where({ title: 'viewer' })).toHaveLength(0);
  });

  it('answers a foreign transfer like a missing one, on every route', async () => {
    const foreign = await createSend(tokens.other);
    const mine = as(tokens.write);
    expect((await mine.get(`/transfers/${foreign.id}`)).status).toBe(404);
    expect((await mine.get('/transfers/999999')).status).toBe(404);
    expect((await mine.post(`/transfers/${foreign.id}/files`).attach('files', Buffer.from('%PDF x'), 'a.pdf')).status).toBe(404);
    expect((await mine.post(`/transfers/${foreign.id}/chunked-upload/init`)
      .send({ filename: 'a.pdf', fileSize: 5 })).status).toBe(404);
    expect((await mine.post(`/transfers/${foreign.id}/deliver`).send({ recipient_emails: ['x@example.com'] })).status).toBe(404);
    expect(await db('transfer_extra_files').where({ transfer_id: foreign.id })).toHaveLength(0);
    expect(mockSendTemplateEmail).not.toHaveBeenCalled();
    // The list holds only the caller's own; a super_admin's token sees both.
    const listed = (await mine.get('/transfers')).body.transfers.map((t) => t.id);
    expect(listed).not.toContain(foreign.id);
    expect((await as(tokens.superAdmin).get(`/transfers/${foreign.id}`)).status).toBe(200);
  });

  it('is closed while PicTransfer is switched off', async () => {
    const send = await createSend(tokens.write);
    await setTransfersFlag(false);
    expect((await as(tokens.write).get(`/transfers/${send.id}`)).status).toBe(403);
    expect((await as(tokens.write).post('/transfers').send({ title: 'off' })).status).toBe(403);
  });
});

describe('create, upload, deliver', () => {
  it('creates a send owned by the token owner, with its share link', async () => {
    const send = await createSend(tokens.write, { message: 'All files', expires_in_days: 30, max_downloads: 5 });
    const row = await db('transfers').where({ id: send.id }).first();
    expect(row).toMatchObject({ kind: 'send', title: 'Booth handover', message: 'All files', created_by: ownerId });
    expect(Number(row.max_downloads)).toBe(5);
    expect(send.share_url).toMatch(new RegExp(`/transfer/${row.token}$`));
    const read = await as(tokens.write).get(`/transfers/${send.id}`);
    expect(read.status).toBe(200);
    expect(read.body.transfer).toMatchObject({ id: send.id, status: 'active', share_url: send.share_url });
  });

  it('rejects invalid create data before anything is stored', async () => {
    for (const body of [{ expires_in_days: 0 }, { recipient_emails: ['not-an-email'] }, { title: 'x'.repeat(256) }]) {
      const res = await as(tokens.write).post('/transfers').send(body);
      expect(res.status).toBe(400);
    }
  });

  it('uploads files of any allowed type in one request', async () => {
    const send = await createSend(tokens.write);
    const res = await as(tokens.write).post(`/transfers/${send.id}/files`)
      .attach('files', Buffer.from('PK zip'), 'Originals.zip')
      .attach('files', Buffer.from('%PDF guestbook'), 'Gästebuch.pdf');
    expect(res.status).toBe(200);
    expect(res.body.rejected_files).toEqual([]);
    const rows = await db('transfer_extra_files').where({ transfer_id: send.id }).orderBy('id');
    expect(rows.map((r) => r.original_filename)).toEqual(['Originals.zip', 'Gästebuch.pdf']);
    expect(storedBytes(rows[0].stored_path).toString()).toBe('PK zip');
  });

  it('stores a traversal filename under an opaque key and refuses a type that is not allowed', async () => {
    const send = await createSend(tokens.write);
    const traversal = await as(tokens.write).post(`/transfers/${send.id}/files`)
      .attach('files', Buffer.from('PK'), '../../../etc/evil.zip');
    expect(traversal.status).toBe(200);
    const [row] = await db('transfer_extra_files').where({ transfer_id: send.id });
    expect(row.stored_path).not.toContain('..');
    expect(row.stored_path).not.toContain('evil');
    expect(row.original_filename).not.toContain('/');

    const rejected = await as(tokens.write).post(`/transfers/${send.id}/files`)
      .attach('files', Buffer.from('MZ'), 'setup.exe');
    expect(rejected.status).toBe(400);
    expect(rejected.body).toMatchObject({ code: 'TYPE_REJECTED', rejected_files: ['setup.exe'] });
    expect(await db('transfer_extra_files').where({ transfer_id: send.id })).toHaveLength(1);
  });

  it('holds every file to the transfer size cap, multipart and chunked', async () => {
    await setSetting('transfer_max_upload_size_mb', 1);
    const send = await createSend(tokens.write);
    const big = crypto.randomBytes(1024 * 1024 + 1);
    const multipart = await as(tokens.write).post(`/transfers/${send.id}/files`).attach('files', big, 'big.zip');
    expect(multipart.status).toBe(400);
    expect(multipart.body.code).toBe('UPLOAD_REJECTED');
    const init = await as(tokens.write).post(`/transfers/${send.id}/chunked-upload/init`)
      .send({ filename: 'big.zip', fileSize: big.length, mimeType: 'application/zip' });
    expect(init.status).toBe(413);
    expect(await db('transfer_extra_files').where({ transfer_id: send.id })).toHaveLength(0);
  });

  it('takes a large file in chunks, stored byte for byte', async () => {
    const send = await createSend(tokens.write);
    const bytes = crypto.randomBytes(CHUNK + 2048);
    const init = await as(tokens.write).post(`/transfers/${send.id}/chunked-upload/init`)
      .send({ filename: 'Film.zip', fileSize: bytes.length, mimeType: 'application/zip' });
    expect(init.status).toBe(200);
    expect(init.body.expectedChunks).toBe(2);
    // Another account's token cannot write into this upload, even on its own transfer.
    const othersSend = await createSend(tokens.other);
    const hijack = await as(tokens.other)
      .post(`/transfers/${othersSend.id}/chunked-upload/${init.body.uploadId}/chunk/0`)
      .set('Content-Type', 'application/octet-stream').send(bytes.subarray(0, CHUNK));
    expect(hijack.status).toBe(404);
    for (let i = 0; i < init.body.expectedChunks; i += 1) {
      const chunk = await as(tokens.write).post(`/transfers/${send.id}/chunked-upload/${init.body.uploadId}/chunk/${i}`)
        .set('Content-Type', 'application/octet-stream').send(bytes.subarray(i * CHUNK, (i + 1) * CHUNK));
      expect(chunk.status).toBe(200);
    }
    const done = await as(tokens.write).post(`/transfers/${send.id}/chunked-upload/${init.body.uploadId}/complete`).send({});
    expect(done.status).toBe(200);
    const [row] = await db('transfer_extra_files').where({ transfer_id: send.id });
    expect(row.original_filename).toBe('Film.zip');
    expect(storedBytes(row.stored_path).equals(bytes)).toBe(true);
  });

  it('aborts an unfinished chunked upload', async () => {
    const send = await createSend(tokens.write);
    const init = await as(tokens.write).post(`/transfers/${send.id}/chunked-upload/init`)
      .send({ filename: 'a.zip', fileSize: 10, mimeType: 'application/zip' });
    expect(init.status).toBe(200);
    expect((await as(tokens.write).delete(`/transfers/${send.id}/chunked-upload/${init.body.uploadId}`)).status).toBe(200);
    expect((await as(tokens.write).delete(`/transfers/${send.id}/chunked-upload/${init.body.uploadId}`)).status).toBe(404);
  });

  it('mails the recipients only on deliver, and a retry does not mail them twice', async () => {
    const send = await createSend(tokens.write, { recipient_emails: ['client@example.com'] });
    expect(send.recipients).toEqual([expect.objectContaining({ email: 'client@example.com', held: true })]);
    // The upload lands while the send is held for delivery: no mail yet.
    const upload = await as(tokens.write).post(`/transfers/${send.id}/files`).attach('files', Buffer.from('PK'), 'All.zip');
    expect(upload.status).toBe(200);
    expect(mockSendTemplateEmail).not.toHaveBeenCalled();

    const deliver = await as(tokens.write).post(`/transfers/${send.id}/deliver`).send({});
    expect(deliver.status).toBe(200);
    expect(deliver.body).toMatchObject({ sent: 1, held: false, already_sent: [], share_url: send.share_url });
    expect(mockSendTemplateEmail).toHaveBeenCalledTimes(1);
    expect(mockSendTemplateEmail.mock.calls[0][0]).toBe('client@example.com');
    expect(mockSendTemplateEmail.mock.calls[0][1]).toBe('transfer_ready');

    const retry = await as(tokens.write).post(`/transfers/${send.id}/deliver`).send({});
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ sent: 0, already_sent: ['client@example.com'] });
    expect(mockSendTemplateEmail).toHaveBeenCalledTimes(1);

    const again = await as(tokens.write).post(`/transfers/${send.id}/deliver`).send({ resend: true });
    expect(again.body.sent).toBe(1);
    expect(mockSendTemplateEmail).toHaveBeenCalledTimes(2);
  });

  it('keeps the mail held when deliver comes before any file, and sends it with the first one', async () => {
    const send = await createSend(tokens.write);
    const deliver = await as(tokens.write).post(`/transfers/${send.id}/deliver`).send({ recipient_emails: ['early@example.com'] });
    expect(deliver.status).toBe(200);
    expect(deliver.body).toMatchObject({ sent: 0, held: true });
    expect(mockSendTemplateEmail).not.toHaveBeenCalled();
    await as(tokens.write).post(`/transfers/${send.id}/files`).attach('files', Buffer.from('PK'), 'Late.zip');
    expect(mockSendTemplateEmail).toHaveBeenCalledTimes(1);
  });

  it('returns the link without mailing when the send has no recipients', async () => {
    const send = await createSend(tokens.write);
    const deliver = await as(tokens.write).post(`/transfers/${send.id}/deliver`).send({});
    expect(deliver.status).toBe(200);
    expect(deliver.body).toMatchObject({ sent: 0, share_url: send.share_url });
    expect(mockSendTemplateEmail).not.toHaveBeenCalled();
  });

  it.each([
    ['disabled', { is_active: false }, 'TRANSFER_DISABLED'],
    ['expired', { expires_at: new Date(Date.now() - 864e5).toISOString() }, 'TRANSFER_EXPIRED'],
  ])('refuses to deliver a %s transfer with 409 and mails nothing', async (_label, patch, reason) => {
    const send = await createSend(tokens.write, { recipient_emails: ['late@example.com'] });
    await as(tokens.write).post(`/transfers/${send.id}/files`).attach('files', Buffer.from('PK'), 'All.zip');
    await db('transfers').where({ id: send.id }).update(patch);
    const deliver = await as(tokens.write).post(`/transfers/${send.id}/deliver`).send({});
    expect(deliver.status).toBe(409);
    expect(deliver.body).toMatchObject({ code: 'TRANSFER_NOT_ACTIVE', reason });
    expect(mockSendTemplateEmail).not.toHaveBeenCalled();
    const [recipient] = await db('transfer_recipients').where({ transfer_id: send.id });
    expect(recipient.last_sent_at).toBeNull();
  });

  it('neither uploads into nor mails a file request made in the admin UI', async () => {
    const id = unwrap(await db('transfers').insert({
      token: crypto.randomBytes(32).toString('hex'), kind: 'request', title: 'Request', expires_at: new Date(Date.now() + 864e5).toISOString(),
      is_active: true, grace_days: 7, allow_uploads: true, created_by: ownerId,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }).returning('id'));
    expect((await as(tokens.write).get(`/transfers/${id}`)).body.transfer.share_url).toBeNull();
    const upload = await as(tokens.write).post(`/transfers/${id}/files`).attach('files', Buffer.from('PK'), 'a.zip');
    expect(upload.status).toBe(400);
    expect(upload.body.code).toBe('NOT_A_SEND');
    const deliver = await as(tokens.write).post(`/transfers/${id}/deliver`).send({ recipient_emails: ['x@example.com'] });
    expect(deliver.body.code).toBe('NOT_A_SEND');
  });
});
