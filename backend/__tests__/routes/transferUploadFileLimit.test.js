'use strict';

/**
 * How many files a client may select in one upload round is configurable
 * (issue 1914): a global default under Settings > PicTransfer, and an
 * optional value on a single file request.
 *
 * It was the constant 25 in publicTransferUpload.js. The upload page already
 * read the number from the server, so the server is the whole contract: what
 * it reports in `max_files` and what it then accepts in one request.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-transfer-limit-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'transfer-limit-test-secret-32-chars!!';
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-transfer-limit-storage-'));

const request = require('supertest');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp,
} = require('../integration/helpers/crmDb');

jest.setTimeout(120000);

let db; let cleanup; let admin; let settings; let pub; let token;
const auth = (req) => req.set('Authorization', `Bearer ${token}`);
const createRequest = (fields = {}) => {
  let req = auth(request(admin).post('/api/admin/transfers')).field('kind', 'request').field('title', 'Send your photos');
  for (const [key, value] of Object.entries(fields)) req = req.field(key, String(value));
  return req;
};
const patch = (id, body) => auth(request(admin).patch(`/api/admin/transfers/${id}`)).send(body);
const detail = async (id) => (await auth(request(admin).get(`/api/admin/transfers/${id}`))).body.transfer;
const reported = async (transfer) => (await request(pub).get(`/api/public/transfer-upload/${transfer.token}`)).body.transfer.max_files;
const setDefault = (value) => auth(request(settings).put('/api/admin/settings/transfers')).send({ max_files: value });
const upload = (transfer, count) => {
  let req = request(pub).post(`/api/public/transfer-upload/${transfer.token}`);
  for (let i = 0; i < count; i += 1) req = req.attach('files', Buffer.from(`%PDF-1.4 file ${i}`), `file-${i}.pdf`);
  return req;
};

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  const { adminId } = await seedMinimal(db);
  await assignAdminRole(db, adminId, 'super_admin');
  token = mintAdminToken(adminId);
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
  settings = buildRouteApp('/api/admin/settings', require('../../src/routes/adminSettings'));
  pub = buildRouteApp('/api/public/transfer-upload', require('../../src/routes/publicTransferUpload'));
});

afterAll(async () => { if (cleanup) await cleanup(); });

describe('the global default', () => {
  it('is 25 until someone sets it, exactly as before', async () => {
    const created = (await createRequest()).body.transfer;
    expect(created.max_files_per_upload).toBeNull();
    expect(created.effective_max_files_per_upload).toBe(25);
    expect(await reported(created)).toBe(25);
    const defaults = await auth(request(admin).get('/api/admin/transfers/upload-defaults'));
    expect(defaults.body).toMatchObject({ max_files_per_upload: 25, max_files_ceiling: 1000 });
  });

  it('refuses a value that is not a whole number from 1 to 1000, and stores nothing', async () => {
    for (const bad of [0, 1001, -3, 2.5, 'many', null]) {
      const res = await setDefault(bad);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('BAD_FILE_COUNT');
    }
    expect(await db('app_settings').where({ setting_key: 'transfer_upload_max_files' }).first()).toBeUndefined();
  });

  it('applies to every request without a value of its own, existing ones included', async () => {
    const before = (await createRequest()).body.transfer;
    expect((await setDefault(100)).status).toBe(200);
    expect((await auth(request(settings).get('/api/admin/settings/transfers'))).body.max_files).toBe(100);
    expect(await reported(before)).toBe(100);
    expect((await detail(before.id)).effective_max_files_per_upload).toBe(100);
  });
});

describe('a request with its own limit', () => {
  it('keeps it whatever the default is, and can hand it back', async () => {
    await setDefault(100);
    const res = await createRequest({ maxFilesPerUpload: 300 });
    expect(res.status).toBe(201);
    const own = res.body.transfer;
    expect(own.max_files_per_upload).toBe(300);
    expect(own.effective_max_files_per_upload).toBe(300);
    expect(await reported(own)).toBe(300);

    await setDefault(40);
    expect(await reported(own)).toBe(300);

    expect((await patch(own.id, { maxFilesPerUpload: 5 })).body.transfer.max_files_per_upload).toBe(5);
    expect(await reported(own)).toBe(5);

    // null clears the override: back to whatever the default is now.
    const cleared = (await patch(own.id, { maxFilesPerUpload: null })).body.transfer;
    expect(cleared.max_files_per_upload).toBeNull();
    expect(cleared.effective_max_files_per_upload).toBe(40);
    expect(await reported(own)).toBe(40);

    // A patch that does not mention it leaves it alone.
    await patch(own.id, { maxFilesPerUpload: 7 });
    await patch(own.id, { title: 'Renamed' });
    expect((await detail(own.id)).max_files_per_upload).toBe(7);
  });

  it('is refused when it is not a usable number, on create and on update', async () => {
    const count = async () => Number((await db('transfers').count('* as c').first()).c);
    const before = await count();
    for (const bad of ['abc', '0', '1001', '2.5']) {
      const res = await createRequest({ maxFilesPerUpload: bad });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('BAD_FILE_COUNT');
    }
    expect(await count()).toBe(before);
    // Left empty means "use the default", as the dialog sends it.
    expect((await createRequest({ maxFilesPerUpload: '' })).body.transfer.max_files_per_upload).toBeNull();

    const own = (await createRequest({ maxFilesPerUpload: 10 })).body.transfer;
    expect((await patch(own.id, { maxFilesPerUpload: 0 })).status).toBe(400);
    expect((await patch(own.id, { maxFilesPerUpload: 1001 })).status).toBe(400);
    expect((await detail(own.id)).max_files_per_upload).toBe(10);
  });

  it('means nothing on an outgoing transfer', async () => {
    const [id] = await db('transfers').insert({
      token: 'e'.repeat(64), kind: 'send', title: 'Delivery', is_active: true, grace_days: 7, allow_uploads: false,
      expires_at: new Date(Date.now() + 864e5).toISOString(),
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }).returning('id');
    const sendId = typeof id === 'object' ? id.id : id;
    const patched = (await patch(sendId, { maxFilesPerUpload: 50 })).body.transfer;
    expect(patched.max_files_per_upload).toBeNull();
    expect(patched.effective_max_files_per_upload).toBeNull();
    expect((await db('transfers').where({ id: sendId }).first()).max_files_per_upload).toBeNull();
  });
});

describe('the upload route enforces the number it reports', () => {
  it('accepts a round of exactly the limit and refuses one file more', async () => {
    const own = (await createRequest({ maxFilesPerUpload: 2 })).body.transfer;
    const ok = await upload(own, 2);
    expect(ok.status).toBe(201);
    expect(await db('transfer_uploads').where({ transfer_id: own.id })).toHaveLength(2);

    const over = await upload(own, 3);
    expect(over.status).toBeGreaterThanOrEqual(400);
    expect(over.status).toBeLessThan(500);
    expect(await db('transfer_uploads').where({ transfer_id: own.id })).toHaveLength(2);
  });
});
