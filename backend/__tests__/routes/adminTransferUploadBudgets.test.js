'use strict';

/**
 * Text-field budgets on the admin transfer multipart routes.
 *
 * Busboy buffers every text part in memory before the handler runs, and the
 * shared uploader declared no `fields`, `fieldSize` or `parts` limit — so a
 * delegated admin could send an unbounded number of large text parts and
 * hold them all on the heap. Create reads a fixed set of named fields;
 * adding files to an existing transfer reads none.
 */

const request = require('supertest');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp,
} = require('../integration/helpers/crmDb');

jest.setTimeout(120000);

let db; let cleanup; let adminApp; let token;

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  const { adminId } = await seedMinimal(db);
  await assignAdminRole(db, adminId, 'super_admin');
  token = mintAdminToken(adminId);

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

  const flag = await db('feature_flags').where({ key: 'transfers' }).first();
  if (flag) await db('feature_flags').where({ key: 'transfers' }).update({ value: true });
  else await db('feature_flags').insert({ key: 'transfers', value: true });

  adminApp = buildRouteApp('/api/admin/transfers', require('../../src/routes/adminTransfers'));
});

afterAll(async () => { if (cleanup) await cleanup(); });

const create = () => request(adminApp)
  .post('/api/admin/transfers')
  .set('Authorization', `Bearer ${token}`);

describe('creating a transfer', () => {
  it('still accepts every documented field', async () => {
    const res = await create()
      .field('title', 'Budget check')
      .field('message', 'hello')
      .field('expiresInDays', '7')
      .field('maxDownloads', '3')
      .field('graceDays', '1')
      .field('allowUploads', 'false')
      .field('uploadExpiresInDays', '7')
      .field('photoIds', JSON.stringify([]))
      .field('deliveryMethod', 'link')
      .field('recipientEmails', JSON.stringify([]))
      .attach('files', Buffer.from('good'), { filename: 'album.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(201);
  });

  it('rejects more text fields than the handler reads', async () => {
    const before = await db('transfers').count('* as c').first();
    let req = create();
    for (let i = 0; i < 12; i++) req = req.field(`junk_${i}`, 'x');
    const res = await req.attach('files', Buffer.from('good'), { filename: 'album.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('UPLOAD_REJECTED');
    const after = await db('transfers').count('* as c').first();
    expect(Number(after.c)).toBe(Number(before.c));
  });

  it('rejects a text field far above what any documented field needs', async () => {
    const res = await create()
      .field('message', 'a'.repeat(256 * 1024))
      .attach('files', Buffer.from('good'), { filename: 'album.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('UPLOAD_REJECTED');
  });
});

describe('adding files to an existing transfer', () => {
  let transferId;

  beforeAll(async () => {
    const res = await create()
      .attach('files', Buffer.from('good'), { filename: 'album.pdf', contentType: 'application/pdf' });
    transferId = res.body.transfer.id;
  });

  it('accepts files alone', async () => {
    const res = await request(adminApp)
      .post(`/api/admin/transfers/${transferId}/upload-files`)
      .set('Authorization', `Bearer ${token}`)
      .attach('files', Buffer.from('more'), { filename: 'b.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(200);
  });

  it('rejects any text field, since the handler reads none', async () => {
    const res = await request(adminApp)
      .post(`/api/admin/transfers/${transferId}/upload-files`)
      .set('Authorization', `Bearer ${token}`)
      .field('title', 'x')
      .attach('files', Buffer.from('more'), { filename: 'c.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('UPLOAD_REJECTED');
    const extras = await db('transfer_extra_files').where({ transfer_id: transferId });
    // Only the two files the accepted requests added.
    expect(extras).toHaveLength(2);
  });
});

// Both multer routes take the authenticated upload admission: a concurrency
// slot and the free-disk check, released once the files are stored.
describe('authenticated upload admission', () => {
  const fs = require('fs');
  let quota; let transferId;

  beforeAll(async () => {
    // After bootCrmDb: the service opens the database when it is loaded.
    quota = require('../../src/services/publicUploadQuota');
    const res = await create().field('kind', 'send')
      .attach('files', Buffer.from('good'), { filename: 'album.pdf', contentType: 'application/pdf' });
    transferId = res.body.transfer.id;
  });
  // The slot is released just after the response is written.
  const settled = async () => {
    for (let n = 0; n < 200 && await db('public_upload_requests').where({ active: 1 }).first(); n++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  afterEach(async () => { delete process.env.ADMIN_UPLOAD_LIMITS_JSON; jest.restoreAllMocks(); await settled(); });

  const addFiles = () => request(adminApp)
    .post(`/api/admin/transfers/${transferId}/upload-files`)
    .set('Authorization', `Bearer ${token}`)
    .attach('files', Buffer.from('more'), { filename: 'd.pdf', contentType: 'application/pdf' });
  const createSend = () => create().field('kind', 'send')
    .attach('files', Buffer.from('good'), { filename: 'album.pdf', contentType: 'application/pdf' });

  it('records each accepted upload as a released authenticated request', async () => {
    await db('public_upload_requests').del();
    expect((await addFiles()).status).toBe(200);
    expect((await createSend()).status).toBe(201);
    await settled();
    const rows = await db('public_upload_requests');
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row).toMatchObject({ upload_kind: 'admin', active: 0, bytes: 0, rate_bytes: 0 });
  });

  it.each([['create', createSend], ['upload-files', addFiles]])('refuses %s while every slot is taken, then admits it', async (_name, send) => {
    process.env.ADMIN_UPLOAD_LIMITS_JSON = '{"requests":1}';
    const held = await quota.begin({ mode: 'admin', accountId: 999, maxFiles: 1, requestedBytes: 10 });
    const before = await db('transfer_extra_files').count('* as c').first();
    const refused = await send();
    expect(refused.status).toBe(429);
    expect(refused.body.code).toBe('UPLOAD_CONCURRENCY_LIMIT');
    expect(refused.body.error).not.toMatch(/gallery owner/);
    expect(Number((await db('transfer_extra_files').count('* as c').first()).c)).toBe(Number(before.c));
    await quota.finish(held);
    await settled();
    expect((await send()).status).toBeLessThan(300);
  });

  it('refuses an upload the disk has no headroom for', async () => {
    jest.spyOn(fs.promises, 'statfs').mockResolvedValue({ bavail: 1, bsize: 4096, blocks: 1000000, ffree: 100000 });
    const res = await addFiles();
    expect(res.status).toBe(507);
    expect(res.body.code).toBe('UPLOAD_STORAGE_LOW');
  });
});
