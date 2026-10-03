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
      .field('kind', 'send')
      .field('title', 'Budget check')
      .field('message', 'hello')
      .field('expiresInDays', '7')
      .field('maxDownloads', '3')
      .field('graceDays', '1')
      .field('photoIds', JSON.stringify([]))
      .field('deliveryMethod', 'link')
      .field('recipientEmails', JSON.stringify([]))
      .attach('files', Buffer.from('good'), { filename: 'album.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(201);
  });

  it('rejects more text fields than the handler reads', async () => {
    const before = await db('transfers').count('* as c').first();
    let req = create().field('kind', 'send');
    for (let i = 0; i < 12; i++) req = req.field(`junk_${i}`, 'x');
    const res = await req.attach('files', Buffer.from('good'), { filename: 'album.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('UPLOAD_REJECTED');
    const after = await db('transfers').count('* as c').first();
    expect(Number(after.c)).toBe(Number(before.c));
  });

  it('rejects a text field far above what any documented field needs', async () => {
    const res = await create()
      .field('kind', 'send')
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
      .field('kind', 'send')
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
