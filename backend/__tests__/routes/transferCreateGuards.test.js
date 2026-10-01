'use strict';

/**
 * A send has to be sending something (#1544).
 *
 * On `main` the multer fileFilter THREW on an unsupported type, so a create
 * whose files were all rejected was a 400 and no row existed. Skipping instead
 * of throwing is what lets one bad file in a batch stop rejecting the good
 * ones — but it also means a create where NOTHING survived would otherwise
 * produce an empty send, and with `deliveryMethod: 'email'` mail the recipient
 * "your files are ready" for a transfer holding nothing.
 *
 * Also pins the NOT_A_SEND guards: a request has no outbound content, so
 * neither photos nor deliverable files may be attached to one.
 */

const request = require('supertest');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp,
} = require('../integration/helpers/crmDb');

jest.setTimeout(120000);

let db; let cleanup; let adminApp; let adminId; let token;

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  ({ adminId } = await seedMinimal(db));
  await assignAdminRole(db, adminId, 'super_admin');
  token = mintAdminToken(adminId);

  // Under jest a service's `new Date()` binds as a foreign-realm Date that
  // node-sqlite3 stringifies; normalise bindings the way the other transfer
  // suites do.
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

describe('creating a send with nothing in it', () => {
  it('400s when every attached file was refused on type', async () => {
    const before = await db('transfers').count('* as c').first();

    const res = await create()
      .field('kind', 'send')
      .field('deliveryMethod', 'email')
      .field('recipientEmails', JSON.stringify(['client@example.com']))
      .attach('files', Buffer.from('bad'), { filename: 'macro.exe', contentType: 'application/x-msdownload' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('TYPE_REJECTED');
    expect(res.body.rejected_files).toEqual(['macro.exe']);

    // Nothing was created, so nothing could be mailed.
    const after = await db('transfers').count('* as c').first();
    expect(Number(after.c)).toBe(Number(before.c));
    expect(await db('transfer_recipients').count('* as c').first()).toMatchObject({ c: 0 });
  });

  it('400s a send with no photos and no files at all', async () => {
    const res = await create().field('kind', 'send');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('NOTHING_TO_SEND');
  });

  it('still creates a send that has a surviving file', async () => {
    const res = await create()
      .field('kind', 'send')
      .attach('files', Buffer.from('good'), { filename: 'album.pdf', contentType: 'application/pdf' })
      .attach('files', Buffer.from('bad'), { filename: 'macro.exe', contentType: 'application/x-msdownload' });

    expect(res.status).toBe(201);
    expect(res.body.transfer.kind).toBe('send');
    // The skipped file is named back, next to the transfer.
    expect(res.body.rejected_files).toEqual(['macro.exe']);
  });

  it('creates a request with no files, because collecting is the point', async () => {
    const res = await create().field('kind', 'request').field('title', 'Send me your logo');
    expect(res.status).toBe(201);
    expect(res.body.transfer.kind).toBe('request');
  });

  it('tells the admin when files attached to a request were not kept', async () => {
    const res = await create()
      .field('kind', 'request')
      .attach('files', Buffer.from('good'), { filename: 'brief.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(201);
    expect(res.body.dropped_files).toEqual(['brief.pdf']);
    // A request holds no outbound content.
    const extras = await db('transfer_extra_files').where({ transfer_id: res.body.transfer.id });
    expect(extras).toEqual([]);
  });
});

describe('a request refuses outbound content after the fact', () => {
  let requestId;

  beforeAll(async () => {
    const res = await create().field('kind', 'request').field('title', 'Inbound only');
    requestId = res.body.transfer.id;
  });

  it('refuses deliverable files', async () => {
    const res = await request(adminApp)
      .post(`/api/admin/transfers/${requestId}/upload-files`)
      .set('Authorization', `Bearer ${token}`)
      .attach('files', Buffer.from('x'), { filename: 'a.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('NOT_A_SEND');
  });

  it('refuses gallery photos', async () => {
    const res = await request(adminApp)
      .post(`/api/admin/transfers/${requestId}/files`)
      .set('Authorization', `Bearer ${token}`)
      .send({ photoIds: [1] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('NOT_A_SEND');
  });

  it('refuses the ZIP download', async () => {
    const res = await request(adminApp)
      .get(`/api/admin/transfers/${requestId}/download`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('NOT_A_SEND');
  });
});
