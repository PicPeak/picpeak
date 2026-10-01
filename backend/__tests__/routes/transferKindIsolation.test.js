'use strict';

/**
 * The send/request split holds at the route boundary (#1544).
 *
 * Splitting the flows is only worth anything if a token cannot cross between
 * them. A send's download token reaching the upload route would let anyone
 * holding a delivery link push files into the photographer's storage; a
 * request's token reaching the download route would hand whoever has the upload
 * link every file the client has already sent. Both are 404s, checked here
 * against the real routers.
 *
 * Also pins the batch behaviour: one unsupported file no longer rejects the
 * good files alongside it.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long!!';

const request = require('supertest');
const { bootCrmDb, buildRouteApp } = require('../integration/helpers/crmDb');

let db;
let cleanup;
let uploadApp;
let downloadApp;

const SEND_TOKEN = 'a'.repeat(64);
const REQUEST_TOKEN = 'b'.repeat(64);
const REQUEST_CODE = 'SHORTCODE1';

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());

  const flag = await db('feature_flags').where({ key: 'transfers' }).first();
  if (flag) await db('feature_flags').where({ key: 'transfers' }).update({ value: true });
  else await db('feature_flags').insert({ key: 'transfers', value: true });

  const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  await db('transfers').insert([
    {
      token: SEND_TOKEN, kind: 'send', title: 'Delivery', expires_at: future,
      is_active: true, grace_days: 7, allow_uploads: false,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    },
    {
      token: REQUEST_TOKEN, kind: 'request', title: 'Please send your logo', expires_at: future,
      is_active: true, grace_days: 7, allow_uploads: true, upload_token: REQUEST_CODE,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    },
  ]);

  uploadApp = buildRouteApp('/api/public/transfer-upload', require('../../src/routes/publicTransferUpload'));
  downloadApp = buildRouteApp('/api/public/transfer', require('../../src/routes/publicTransfer'));
}, 120000);

afterAll(async () => { if (cleanup) await cleanup(); });

describe('the lookup layer filters on kind by itself', () => {
  // The route tests below pass if EITHER the query filter or the assert* gate
  // holds, so on their own they prove the pair, not each half. These pin the
  // query layer directly; transferService.gating.test.js pins the gates.
  //
  // Required in beforeAll, not at describe-evaluation time: requiring the
  // service pulls in db.js, and bootCrmDb has to set TEST_DATABASE_PATH before
  // that module binds its pool.
  let transferService;
  beforeAll(() => { transferService = require('../../src/services/transferService'); });

  it('getTransferByToken does not return a request', async () => {
    expect(await transferService.getTransferByToken(REQUEST_TOKEN)).toBeUndefined();
    expect(await transferService.getTransferByToken(SEND_TOKEN)).toBeDefined();
  });

  it('getRequestByToken does not return a send', async () => {
    expect(await transferService.getRequestByToken(SEND_TOKEN)).toBeUndefined();
    expect(await transferService.getRequestByToken(REQUEST_TOKEN)).toBeDefined();
  });

  it('getTransferByUploadToken does not return a send that still holds a code', async () => {
    // Post-257 no send carries an upload_token, but a stray legacy row must
    // not reopen the old combined behaviour.
    await db('transfers').where({ token: SEND_TOKEN }).update({ upload_token: 'LEGACYCODE' });
    expect(await transferService.getTransferByUploadToken('LEGACYCODE')).toBeUndefined();
    await db('transfers').where({ token: SEND_TOKEN }).update({ upload_token: null });
  });
});

describe('a send token cannot reach the upload route', () => {
  it('404s on the metadata endpoint', async () => {
    const res = await request(uploadApp).get(`/api/public/transfer-upload/${SEND_TOKEN}`);
    expect(res.status).toBe(404);
  });

  it('404s on the upload endpoint, before any bytes are taken', async () => {
    const res = await request(uploadApp)
      .post(`/api/public/transfer-upload/${SEND_TOKEN}`)
      .attach('files', Buffer.from('x'), 'a.png');
    expect(res.status).toBe(404);
    expect(await db('transfer_uploads').count('* as c').first()).toMatchObject({ c: 0 });
  });
});

describe('a request token cannot reach the download route', () => {
  it('404s the public view', async () => {
    const res = await request(downloadApp).get(`/api/public/transfer/${REQUEST_TOKEN}`);
    expect(res.status).toBe(404);
  });

  it('404s the ZIP download', async () => {
    const res = await request(downloadApp).get(`/api/public/transfer/${REQUEST_TOKEN}/download`);
    expect(res.status).toBe(404);
  });
});

describe('a request opens on both of its links', () => {
  it('resolves by its 64-hex token', async () => {
    const res = await request(uploadApp).get(`/api/public/transfer-upload/${REQUEST_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.transfer.title).toBe('Please send your logo');
  });

  it('resolves by its short read-aloud code', async () => {
    const res = await request(uploadApp).get(`/api/public/transfer-upload/${REQUEST_CODE}`);
    expect(res.status).toBe(200);
  });

  it('advertises the policy so the page can filter before uploading', async () => {
    const res = await request(uploadApp).get(`/api/public/transfer-upload/${REQUEST_TOKEN}`);
    expect(res.body.transfer.accept_all).toBe(false);
    expect(res.body.transfer.allowed_extensions).toEqual(expect.arrayContaining(['.zip', '.pdf']));
  });
});

describe('a batch with one unsupported file', () => {
  it('stores the good files and names only the dropped one', async () => {
    const res = await request(uploadApp)
      .post(`/api/public/transfer-upload/${REQUEST_TOKEN}`)
      .attach('files', Buffer.from('good'), { filename: 'logo.png', contentType: 'image/png' })
      .attach('files', Buffer.from('bad'), { filename: 'macro.exe', contentType: 'application/x-msdownload' });

    expect(res.status).toBe(201);
    expect(res.body.uploaded).toBe(1);
    expect(res.body.rejected_files).toEqual(['macro.exe']);
  });

  it('stores the accepted file under an opaque .bin key', async () => {
    const row = await db('transfer_uploads').where({ original_filename: 'logo.png' }).first();
    expect(row).toBeDefined();
    // The name the recipient sees is the row's, not the key's.
    expect(row.stored_path).toMatch(/^uploads\/transfers\/\d+\/[a-f0-9]{32}\.bin$/);
    expect(row.stored_path).not.toContain('.png');
  });

  it('400s with the names when every file is unsupported', async () => {
    const res = await request(uploadApp)
      .post(`/api/public/transfer-upload/${REQUEST_TOKEN}`)
      .attach('files', Buffer.from('bad'), { filename: 'a.exe', contentType: 'application/x-msdownload' })
      .attach('files', Buffer.from('bad'), { filename: 'b.bat', contentType: 'application/x-bat' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('TYPE_REJECTED');
    expect(res.body.rejected_files).toEqual(['a.exe', 'b.bat']);
  });
});

describe('the files-received notice is coalesced', () => {
  // The upload route is unauthenticated — the link IS the secret — and its
  // limiter allows 10 POSTs a minute per /64. One mail per batch would let
  // anyone holding a request link fill the creator's inbox.
  const uploadOne = (name) => request(uploadApp)
    .post(`/api/public/transfer-upload/${REQUEST_TOKEN}`)
    .attach('files', Buffer.from('x'), { filename: name, contentType: 'image/png' });

  beforeAll(async () => {
    await db('transfers').where({ token: REQUEST_TOKEN }).update({ uploads_notified_at: null });
  });

  it('stamps on the first batch and suppresses the next', async () => {
    expect((await uploadOne('n1.png')).status).toBe(201);
    // The notice is fire-and-forget off the response path.
    await new Promise((r) => setTimeout(r, 300));
    const first = await db('transfers').where({ token: REQUEST_TOKEN }).first('uploads_notified_at');
    expect(first.uploads_notified_at).toBeTruthy();

    expect((await uploadOne('n2.png')).status).toBe(201);
    await new Promise((r) => setTimeout(r, 300));
    const second = await db('transfers').where({ token: REQUEST_TOKEN }).first('uploads_notified_at');
    // Unchanged: the second batch did not claim a new notice.
    expect(String(second.uploads_notified_at)).toBe(String(first.uploads_notified_at));
  });

  it('allows another notice once the cooldown has passed', async () => {
    await db('transfers').where({ token: REQUEST_TOKEN })
      .update({ uploads_notified_at: new Date(Date.now() - 60 * 60 * 1000).toISOString() });
    const before = await db('transfers').where({ token: REQUEST_TOKEN }).first('uploads_notified_at');

    expect((await uploadOne('n3.png')).status).toBe(201);
    await new Promise((r) => setTimeout(r, 300));

    const after = await db('transfers').where({ token: REQUEST_TOKEN }).first('uploads_notified_at');
    expect(String(after.uploads_notified_at)).not.toBe(String(before.uploads_notified_at));
  });
});

describe('accept-all', () => {
  afterAll(async () => {
    await db('app_settings')
      .where('setting_key', 'transfer_upload_accept_all')
      .update({ setting_value: JSON.stringify(false) });
  });

  it('takes a type the allowlist refuses once the toggle is on', async () => {
    await db('app_settings')
      .where('setting_key', 'transfer_upload_accept_all')
      .update({ setting_value: JSON.stringify(true) });

    const res = await request(uploadApp)
      .post(`/api/public/transfer-upload/${REQUEST_TOKEN}`)
      .attach('files', Buffer.from('psd'), { filename: 'brand.psd', contentType: 'image/vnd.adobe.photoshop' });

    expect(res.status).toBe(201);
    expect(res.body.uploaded).toBe(1);
    expect(res.body.rejected_files).toEqual([]);
  });

  it('still drops the extension on disk — accept-all widens what is taken, not how it is stored', async () => {
    const row = await db('transfer_uploads').where({ original_filename: 'brand.psd' }).first();
    expect(row.stored_path).toMatch(/\.bin$/);
  });
});
