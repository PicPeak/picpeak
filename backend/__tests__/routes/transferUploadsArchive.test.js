/**
 * "Download all" for the files a client sent through a file request
 * (issue 1914).
 *
 * Received files could only be fetched one at a time; the ZIP route answered
 * NOT_A_SEND for a request. The new route zips every upload round under the
 * names the client gave, keeps two files with the same name apart, and is
 * refused for a send, for a request nothing was sent to, and without
 * photos.download.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const zlib = require('zlib');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-uploads-zip-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'uploads-zip-test-secret';
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-uploads-zip-storage-'));

const request = require('supertest');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp,
} = require('../integration/helpers/crmDb');
const svc = require('../../src/services/userManagementService');
const { clearPermissionCache } = require('../../src/middleware/permissions');

jest.setTimeout(120000);

let db; let cleanup; let app; let transferService; let storage; let token; let viewerToken;
const future = new Date(Date.now() + 864e5).toISOString();
const auth = (req, tok = token) => req.set('Authorization', `Bearer ${tok}`);
const binary = (res, cb) => { const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); };

/** name -> content for every entry, read from the ZIP's central directory. */
function unzip(buffer) {
  const entries = {};
  // The end record says where the central directory starts and how long it is.
  const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let at = buffer.readUInt32LE(eocd + 16);
  const count = buffer.readUInt16LE(eocd + 10);
  for (let i = 0; i < count; i += 1) {
    const method = buffer.readUInt16LE(at + 10);
    const size = buffer.readUInt32LE(at + 20);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const local = buffer.readUInt32LE(at + 42);
    const name = buffer.toString('utf8', at + 46, at + 46 + nameLength);
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const raw = buffer.subarray(start, start + size);
    entries[name] = (method === 0 ? raw : zlib.inflateRawSync(raw)).toString('utf8');
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function makeTransfer(kind, title) {
  const [id] = await db('transfers').insert({
    token: `${kind}-${Math.random().toString(16).slice(2)}`.padEnd(64, '0').slice(0, 64),
    kind, title, expires_at: future, created_at: new Date().toISOString(),
  }).returning('id');
  return typeof id === 'object' ? id.id : id;
}
async function receive(transferId, filename, content, uploadedAt) {
  const key = transferService.newUploadFileKey(transferId);
  await storage.put(key, Buffer.from(content));
  const id = await transferService.addUpload(transferId, {
    originalFilename: filename, storedPath: key, sizeBytes: content.length, mimeType: 'application/octet-stream',
  });
  await db('transfer_uploads').where({ id }).update({ uploaded_at: uploadedAt });
  return id;
}
const download = (id, tok) => auth(request(app).get(`/api/admin/transfers/${id}/uploads/download`), tok);

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  const { adminId } = await seedMinimal(db);
  await assignAdminRole(db, adminId, 'super_admin');
  token = mintAdminToken(adminId);
  // May open the request and fetch single files, but holds no photos.download.
  const role = await svc.createRole({ name: 'transfer_viewer', permissions: ['events.view'] }, adminId);
  const viewer = await db('admin_users').insert({
    username: 'viewer', email: 'viewer@example.com', password_hash: 'x',
    role_id: role.id, must_change_password: false, created_at: new Date().toISOString(),
  }).returning('id');
  viewerToken = mintAdminToken(viewer[0]?.id ?? viewer[0]);
  clearPermissionCache();
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
  transferService = require('../../src/services/transferService');
  storage = require('../../src/services/storage').getStorage();
  app = buildRouteApp('/api/admin/transfers', require('../../src/routes/adminTransfers'));
});

afterEach(() => jest.restoreAllMocks());
afterAll(async () => { if (cleanup) await cleanup(); });

describe('GET /:id/uploads/download', () => {
  it('zips every upload round under the client\'s names and keeps same-named files apart', async () => {
    const id = await makeTransfer('request', 'Hochzeit Müller: Bilder');
    await receive(id, 'IMG_0001.jpg', 'first round', '2026-10-01T10:00:00.000Z');
    await receive(id, 'notes.txt', 'second round', '2026-10-02T10:00:00.000Z');
    const twin = await receive(id, 'img_0001.JPG', 'same name, later', '2026-10-03T10:00:00.000Z');

    const res = await download(id).buffer(true).parse(binary);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename=".*\.zip"/);
    expect(decodeURIComponent(res.headers['content-disposition'])).toContain('Hochzeit Müller');
    expect(unzip(res.body)).toEqual({
      'IMG_0001.jpg': 'first round',
      'notes.txt': 'second round',
      [`${twin}-img_0001.JPG`]: 'same name, later',
    });
  });

  it('keeps looking when the id-prefixed name is itself taken', async () => {
    const id = await makeTransfer('request', 'collisions');
    const first = await receive(id, 'a.txt', 'one', '2026-10-01T10:00:00.000Z');
    // Named like the prefix the third file would get.
    await receive(id, `${first + 2}-a.txt`, 'two', '2026-10-02T10:00:00.000Z');
    const third = await receive(id, 'A.TXT', 'three', '2026-10-03T10:00:00.000Z');
    expect(third).toBe(first + 2);

    const res = await download(id).buffer(true).parse(binary);
    expect(res.status).toBe(200);
    expect(unzip(res.body)).toEqual({
      'a.txt': 'one',
      [`${third}-a.txt`]: 'two',
      [`${third}-2-A.TXT`]: 'three',
    });
  });

  // macOS treats the composed and the decomposed spelling as one file name.
  it('keeps apart two names that differ only in Unicode normalisation', async () => {
    const id = await makeTransfer('request', 'unicode');
    await receive(id, 'M\u00fcller.jpg', 'composed', '2026-10-01T10:00:00.000Z');
    const second = await receive(id, 'Mu\u0308ller.jpg', 'decomposed', '2026-10-02T10:00:00.000Z');

    const res = await download(id).buffer(true).parse(binary);
    expect(res.status).toBe(200);
    expect(unzip(res.body)).toEqual({
      'M\u00fcller.jpg': 'composed',
      [`${second}-Mu\u0308ller.jpg`]: 'decomposed',
    });
  });

  // The id in front of a duplicate must not push a name past what a file
  // system accepts, or that entry cannot be unpacked.
  it('keeps a renamed duplicate within the file name limit, extension intact', async () => {
    const id = await makeTransfer('request', 'long-names');
    const long = `${'ä'.repeat(125)}.jpeg`; // 255 bytes
    expect(Buffer.byteLength(long)).toBe(255);
    await receive(id, long, 'first', '2026-10-01T10:00:00.000Z');
    await receive(id, long, 'second', '2026-10-02T10:00:00.000Z');

    const res = await download(id).buffer(true).parse(binary);
    expect(res.status).toBe(200);
    const names = Object.keys(unzip(res.body));
    expect(names).toHaveLength(2);
    expect(names[0]).toBe(long);
    expect(Buffer.byteLength(names[1])).toBeLessThanOrEqual(255);
    expect(names[1]).toMatch(/^\d+-ä+\.jpeg$/);
    expect(Object.values(unzip(res.body))).toEqual(['first', 'second']);
  });

  it('bounds a single over-long name and keeps apart names that differ only by a trailing dot', async () => {
    const id = await makeTransfer('request', 'edge-names');
    // 480 bytes: fine as a row, too long for any file system.
    await receive(id, `${'\u5199'.repeat(155)}.jpeg`, 'long', '2026-10-01T10:00:00.000Z');
    await receive(id, 'report.pdf', 'one', '2026-10-02T10:00:00.000Z');
    const dotted = await receive(id, 'report.pdf.', 'two', '2026-10-03T10:00:00.000Z');

    const res = await download(id).buffer(true).parse(binary);
    expect(res.status).toBe(200);
    const entries = unzip(res.body);
    const names = Object.keys(entries);
    expect(names).toHaveLength(3);
    for (const name of names) expect(Buffer.byteLength(name)).toBeLessThanOrEqual(255);
    expect(names[0]).toMatch(/^\u5199+\.jpeg$/);
    expect(entries['report.pdf']).toBe('one');
    expect(entries[`${dotted}-report.pdf`]).toBe('two');
  });

  it('treats names as one that a case-insensitive file system folds together, also after shortening', async () => {
    const id = await makeTransfer('request', 'folding');
    await receive(id, '\u03c3.jpg', 'sigma', '2026-10-01T10:00:00.000Z');
    const finalSigma = await receive(id, '\u03c2.jpg', 'final sigma', '2026-10-02T10:00:00.000Z');
    // Shortened to 84 characters plus a space: the space has to go, and then
    // it is the same name as the file that is only those 84 characters.
    const stem = '\u5199'.repeat(84);
    await receive(id, stem, 'short', '2026-10-03T10:00:00.000Z');
    const cut = await receive(id, `${stem} ${'\u5199'.repeat(3)}`, 'cut', '2026-10-04T10:00:00.000Z');

    const res = await download(id).buffer(true).parse(binary);
    expect(res.status).toBe(200);
    const entries = unzip(res.body);
    expect(Object.keys(entries)).toHaveLength(4);
    expect(entries['\u03c3.jpg']).toBe('sigma');
    expect(entries[`${finalSigma}-\u03c2.jpg`]).toBe('final sigma');
    expect(entries[stem]).toBe('short');
    const renamed = Object.keys(entries).find((name) => entries[name] === 'cut');
    expect(renamed.startsWith(`${cut}-`)).toBe(true);
    expect(renamed).not.toMatch(/[. ]$/);
    expect(Buffer.byteLength(renamed)).toBeLessThanOrEqual(255);
  });

  it('renames what Windows reads as a device name', async () => {
    const id = await makeTransfer('request', 'reserved');
    await receive(id, 'CON.jpg', 'c', '2026-10-01T10:00:00.000Z');
    await receive(id, 'aux', 'a', '2026-10-02T10:00:00.000Z');
    await receive(id, 'console.jpg', 'fine', '2026-10-03T10:00:00.000Z');
    await receive(id, 'CON .jpg', 'spaced', '2026-10-04T10:00:00.000Z');
    await receive(id, 'COM\u00b9.jpg', 'superscript', '2026-10-05T10:00:00.000Z');

    const res = await download(id).buffer(true).parse(binary);
    expect(unzip(res.body)).toEqual({
      '_CON.jpg': 'c', _aux: 'a', 'console.jpg': 'fine', '_CON .jpg': 'spaced', '_COM\u00b9.jpg': 'superscript',
    });
  });

  it('answers 429 instead of streaming when the process is already busy with archives', async () => {
    const { streamingArchiveAdmission } = require('../../src/utils/archiveStreamGuard');
    jest.spyOn(streamingArchiveAdmission, 'acquire').mockResolvedValue(null);
    const id = await makeTransfer('request', 'busy');
    await receive(id, 'a.txt', 'a', '2026-10-01T10:00:00.000Z');

    const res = await download(id);
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('ARCHIVES_BUSY');
    expect(res.headers['retry-after']).toBe('10');
    expect(res.headers['content-disposition']).toBeUndefined();
  });

  it('gives its archive slot back when the download is over', async () => {
    const { streamingArchiveAdmission } = require('../../src/utils/archiveStreamGuard');
    const id = await makeTransfer('request', 'slot');
    await receive(id, 'a.txt', 'a', '2026-10-01T10:00:00.000Z');
    const before = streamingArchiveAdmission.active;

    expect((await download(id).buffer(true).parse(binary)).status).toBe(200);
    for (let i = 0; i < 50 && streamingArchiveAdmission.active !== before; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(streamingArchiveAdmission.active).toBe(before);
  });

  // The response can close while a source is being looked up. The guard then
  // destroys the source without listening to it; if that source goes on to
  // fail, nobody handles the error and the process ends.
  it('survives a source that fails after the download was cancelled during its lookup', async () => {
    const id = await makeTransfer('request', 'cancel-mid-lookup');
    await receive(id, 'a.txt', 'a', '2026-10-01T10:00:00.000Z');
    const { Readable } = require('stream');
    const { EventEmitter } = require('events');
    const res = Object.assign(new EventEmitter(), {
      destroyed: false, writableFinished: false, setHeader: jest.fn(),
      write: () => true, end: jest.fn(), destroy: jest.fn(),
    });
    const late = new Readable({ read() {} });
    jest.spyOn(storage, 'get').mockImplementation(async () => {
      res.emit('close'); // cancelled while the source was being opened
      process.nextTick(() => late.destroy(new Error('ENOENT: deleted meanwhile')));
      return late;
    });

    await transferService.streamUploadsArchive({ id, title: 'cancel-mid-lookup' }, res);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(late.destroyed).toBe(true);
  });

  it('opens nothing for a response that was closed before streaming began', async () => {
    const id = await makeTransfer('request', 'closed-early');
    await receive(id, 'a.txt', 'a', '2026-10-01T10:00:00.000Z');
    const get = jest.spyOn(storage, 'get');
    const res = { destroyed: true, setHeader: jest.fn(), on: jest.fn() };

    expect(await transferService.streamUploadsArchive({ id, title: 'closed-early' }, res)).toBe(0);
    expect(get).not.toHaveBeenCalled();
    expect(res.setHeader).not.toHaveBeenCalled();
  });

  // A source that fails while it is still queued has no archiver listener
  // yet: unhandled, that error ends the process.
  it('ends the download, not the process, when a queued source fails', async () => {
    const id = await makeTransfer('request', 'source-fails');
    await receive(id, 'a.txt', 'a'.repeat(1024), '2026-10-01T10:00:00.000Z');
    await receive(id, 'b.txt', 'b', '2026-10-02T10:00:00.000Z');
    const { Readable } = require('stream');
    const opened = [];
    const realGet = storage.get.bind(storage);
    let calls = 0;
    jest.spyOn(storage, 'get').mockImplementation(async (key) => {
      calls += 1;
      if (calls === 1) return realGet(key);
      const failing = new Readable({ read() {} });
      opened.push(failing);
      process.nextTick(() => failing.destroy(Object.assign(new Error('ECONNRESET: source dropped'), { code: 'ECONNRESET' })));
      return failing;
    });

    let outcome;
    try {
      outcome = { response: await download(id).buffer(true).parse(binary).timeout({ response: 4000, deadline: 6000 }) };
    } catch (error) { outcome = { error }; }

    expect(outcome.response || outcome.error).toBeTruthy();
    expect(opened).toHaveLength(1);
    // An 'error' nobody listens for is an uncaught exception, which would have
    // ended this test run; reaching the next request is the proof.
    jest.restoreAllMocks();
    expect((await download(id).buffer(true).parse(binary)).status).toBe(200);
  });

  it('leaves out a file whose bytes are gone instead of failing the archive', async () => {
    const id = await makeTransfer('request', 'partial');
    await receive(id, 'kept.txt', 'still here', '2026-10-01T10:00:00.000Z');
    const lost = await receive(id, 'lost.txt', 'gone', '2026-10-02T10:00:00.000Z');
    await storage.delete((await db('transfer_uploads').where({ id: lost }).first()).stored_path);

    const res = await download(id).buffer(true).parse(binary);
    expect(res.status).toBe(200);
    expect(unzip(res.body)).toEqual({ 'kept.txt': 'still here' });
  });

  it('answers JSON, not an attachment, when there is nothing to zip', async () => {
    const empty = await download(await makeTransfer('request', 'empty'));
    expect(empty.status).toBe(404);
    expect(empty.body.code).toBe('NO_UPLOADS');
    expect(empty.headers['content-disposition']).toBeUndefined();

    const send = await download(await makeTransfer('send', 'outgoing'));
    expect(send.status).toBe(400);
    expect(send.body.code).toBe('NOT_A_REQUEST');

    expect((await download(999999)).status).toBe(404);
  });

  it('needs photos.download, as the outgoing bundle does', async () => {
    const id = await makeTransfer('request', 'guarded');
    await receive(id, 'a.txt', 'a', '2026-10-01T10:00:00.000Z');
    expect((await download(id, viewerToken)).status).toBe(403);
    expect((await request(app).get(`/api/admin/transfers/${id}/uploads/download`)).status).toBe(401);
  });
});

// Issue 2130: the outgoing bundle appended one storage read per file with no
// guard, so a recipient who closed the tab left every opened body (and any
// that resolved afterwards) parked on a pooled S3 socket.
describe('streamTransferArchive releases its reads (issue 2130)', () => {
  async function addExtra(transferId, filename, content) {
    const key = `transfers/bundle-${transferId}/${filename}`;
    await storage.put(key, Buffer.from(content));
    return transferService.addExtraFile(transferId, {
      originalFilename: filename, storedPath: key, sizeBytes: content.length, mimeType: 'text/plain',
    });
  }

  it('zips more files than the guard keeps open at once', async () => {
    const id = await makeTransfer('send', 'bundle');
    for (const n of ['a', 'b', 'c', 'd']) await addExtra(id, `${n}.txt`, `content ${n}`);

    const res = await auth(request(app).get(`/api/admin/transfers/${id}/download`))
      .buffer(true).parse(binary);

    expect(res.status).toBe(200);
    expect(unzip(res.body)).toEqual({
      'a.txt': 'content a', 'b.txt': 'content b', 'c.txt': 'content c', 'd.txt': 'content d',
    });
  });

  it('opens nothing for a response that was closed before streaming began', async () => {
    const id = await makeTransfer('send', 'bundle-closed-early');
    await addExtra(id, 'a.txt', 'a');
    const get = jest.spyOn(storage, 'get');
    const res = { destroyed: true, setHeader: jest.fn(), on: jest.fn() };

    expect(await transferService.streamTransferArchive({ id, title: 'bundle-closed-early' }, res)).toBe(0);
    expect(get).not.toHaveBeenCalled();
    expect(res.setHeader).not.toHaveBeenCalled();
  });

  it('destroys a read that resolves after the recipient left, and opens no more', async () => {
    const id = await makeTransfer('send', 'bundle-cancel');
    await addExtra(id, 'a.txt', 'a');
    await addExtra(id, 'b.txt', 'b');
    const { Readable } = require('stream');
    const { EventEmitter } = require('events');
    const res = Object.assign(new EventEmitter(), {
      destroyed: false, writableFinished: false, setHeader: jest.fn(),
      write: () => true, end: jest.fn(), destroy: jest.fn(),
    });
    const late = new Readable({ read() {} });
    const get = jest.spyOn(storage, 'get').mockImplementation(async () => {
      res.emit('close'); // the recipient left while the read was opening
      return late;
    });

    await transferService.streamTransferArchive({ id, title: 'bundle-cancel' }, res);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(late.destroyed).toBe(true);
    expect(get).toHaveBeenCalledTimes(1);
  });
});
