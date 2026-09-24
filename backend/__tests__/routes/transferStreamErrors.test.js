/**
 * A transfer download whose source stream fails must not take the backend
 * down (the #1128 class, applied to PicTransfer).
 *
 * The transfer routes piped storage and file streams straight into the
 * response. `fs.createReadStream` opens lazily and an S3 body can drop
 * mid-transfer; a source 'error' with no listener is an uncaught throw from
 * an I/O callback, which ends the process. The public single-file route needs
 * no login, so that was an unauthenticated crash. Every transfer stream now
 * goes through pipeStreamToResponse, and the admin upload download opens its
 * body before the attachment headers go on.
 */
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const request = require('supertest');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp,
} = require('../integration/helpers/crmDb');

jest.setTimeout(120000);

let db; let cleanup; let publicApp; let adminApp; let transferService; let storage;
let adminId; let token;
const drain = (res, cb) => { res.on('data', () => {}); res.on('end', () => cb(null, Buffer.alloc(0))); };

/** A source that delivers one chunk, then fails on the next tick, after the headers are out. */
function failingStream() {
  let pushed = false;
  const stream = new Readable({
    read() {
      if (!pushed) { pushed = true; this.push('partial'); return; }
      process.nextTick(() => this.emit('error', Object.assign(new Error('ECONNRESET: source dropped'), { code: 'ECONNRESET' })));
    },
  });
  return stream;
}

// Without the error listener the response is never ended nor destroyed, so
// the request would hang for the whole test timeout; a short deadline turns
// that into a prompt failure of the assertions below instead.
async function settle(req) {
  try { return { response: await req.timeout({ response: 4000, deadline: 6000 }) }; } catch (error) { return { error }; }
}

async function makeTransfer(title) {
  await transferService.createTransfer({ title, maxDownloads: null }, null);
  return db('transfers').orderBy('id', 'desc').first();
}

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  ({ adminId } = await seedMinimal(db));
  await assignAdminRole(db, adminId, 'super_admin');
  token = mintAdminToken(adminId);
  // Under jest a service's `new Date()` binds as a foreign-realm Date that
  // node-sqlite3 stringifies; normalise bindings the way the other
  // transfer suites do.
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
  transferService = require('../../src/services/transferService');
  storage = require('../../src/services/storage').getStorage();
  publicApp = buildRouteApp('/api/public/transfer', require('../../src/routes/publicTransfer'));
  adminApp = buildRouteApp('/api/admin/transfers', require('../../src/routes/adminTransfers'));
});

afterEach(() => jest.restoreAllMocks());
afterAll(async () => { if (cleanup) await cleanup(); });

describe('public transfer downloads', () => {
  it('survives an extra-file stream that fails after the headers went out', async () => {
    const transfer = await makeTransfer('extra-fail');
    const key = `transfers/stream-fail-${transfer.id}/note.txt`;
    await storage.put(key, Buffer.from('hello'));
    const extraId = await transferService.addExtraFile(transfer.id, {
      originalFilename: 'note.txt', storedPath: key, sizeBytes: 5, mimeType: 'text/plain',
    });
    const opened = [];
    jest.spyOn(storage, 'get').mockImplementation(async () => { const s = failingStream(); opened.push(s); return s; });

    const outcome = await settle(request(publicApp)
      .get(`/api/public/transfer/${transfer.token}/download/x${extraId}`).buffer(true).parse(drain));

    // The request ends (a destroyed response or a finished one), the process is
    // still here, and the source had a listener for its failure.
    expect(outcome.response || outcome.error).toBeTruthy();
    expect(opened).toHaveLength(1);
    expect(opened[0].listenerCount('error')).toBeGreaterThan(0);
  });

  it('survives a photo stream that fails after the headers went out', async () => {
    const transfer = await makeTransfer('photo-fail');
    const slug = `stream-fail-${transfer.id}`;
    const [ev] = await db('events').insert({
      slug, event_type: 'wedding', event_name: slug, event_date: '2026-08-01',
      host_email: 'h@e.com', admin_email: 'a@e.com', password_hash: 'x',
      share_token: `t-${slug}`, share_link: `/g/${slug}`, created_by: adminId,
      expires_at: new Date(Date.now() + 864e5).toISOString(), is_active: 1, is_archived: 0, is_draft: 0,
      created_at: new Date().toISOString(),
    }).returning('id');
    const eventId = ev?.id ?? ev;
    const [ph] = await db('photos').insert({
      event_id: eventId, filename: 'a.jpg', path: `${slug}/individual/a.jpg`, type: 'individual',
      mime_type: 'image/jpeg', size_bytes: 5, uploaded_at: new Date().toISOString(),
    }).returning('id');
    const photoId = ph?.id ?? ph;
    await storage.put(`events/active/${slug}/individual/a.jpg`, Buffer.from('jpeg!'));
    await db('transfer_files').insert({ transfer_id: transfer.id, photo_id: photoId, sort_order: 0 });
    const opened = [];
    jest.spyOn(storage, 'get').mockImplementation(async () => { const s = failingStream(); opened.push(s); return s; });

    const outcome = await settle(request(publicApp)
      .get(`/api/public/transfer/${transfer.token}/download/p${photoId}`).buffer(true).parse(drain));

    expect(outcome.response || outcome.error).toBeTruthy();
    expect(opened).toHaveLength(1);
    expect(opened[0].listenerCount('error')).toBeGreaterThan(0);
  });
});

describe('admin upload download', () => {
  it('answers 404 without attachment headers when the local file cannot be opened', async () => {
    const transfer = await makeTransfer('upload-eisdir');
    // A directory passes the existence check and fails on the lazy open (EISDIR).
    const dirKey = `transfers/upload-dir-${transfer.id}`;
    await storage.put(`${dirKey}/inner.txt`, Buffer.from('x'));
    expect(fs.statSync(path.join(process.env.STORAGE_PATH, dirKey)).isDirectory()).toBe(true);
    const uploadId = await transferService.addUpload(transfer.id, {
      originalFilename: 'client.zip', storedPath: dirKey, sizeBytes: 1, mimeType: 'application/zip', ip: '127.0.0.1',
    });

    const res = await request(adminApp)
      .get(`/api/admin/transfers/${transfer.id}/uploads/${uploadId}/download`)
      .set('Authorization', `Bearer ${token}`).timeout({ response: 4000, deadline: 6000 });

    expect(res.status).toBe(404);
    expect(res.headers['content-disposition']).toBeUndefined();
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  it('answers a JSON error without attachment headers when the storage read is refused', async () => {
    const transfer = await makeTransfer('upload-s3-reject');
    const uploadId = await transferService.addUpload(transfer.id, {
      originalFilename: 'client.zip', storedPath: `transfers/missing-${transfer.id}/client.zip`,
      sizeBytes: 1, mimeType: 'application/zip', ip: '127.0.0.1',
    });
    jest.spyOn(storage, 'get').mockRejectedValue(Object.assign(new Error('NoSuchKey'), { statusCode: 404 }));

    const res = await request(adminApp)
      .get(`/api/admin/transfers/${transfer.id}/uploads/${uploadId}/download`)
      .set('Authorization', `Bearer ${token}`).timeout({ response: 4000, deadline: 6000 });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.headers['content-disposition']).toBeUndefined();
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });
});
