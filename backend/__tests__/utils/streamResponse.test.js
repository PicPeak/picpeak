/**
 * The contract that matters here is negative: a source that disappears must
 * NOT be able to end the process (#1128).
 *
 * `fs.createReadStream` is lazy, so its ENOENT lands on a later tick, outside
 * the route's try/catch. An EventEmitter emitting 'error' with no listener
 * throws, and an uncaught throw from an I/O callback exits Node — which is how
 * one missing thumbnail tier took every gallery on the install down.
 *
 * These use a REAL fs stream over a real missing path rather than a fake
 * emitter: the point under test is the lazy-open timing, and a hand-rolled
 * mock that emits synchronously would pass while proving nothing.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { EventEmitter } = require('events');

const { pipeStreamToResponse } = require('../../src/utils/streamResponse');

jest.mock('../../src/utils/logger', () => ({
  warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn(),
}));

/** Minimal Express-ish response that records what happened to it. */
function makeRes() {
  const res = new EventEmitter();
  res.headers = { 'Content-Length': '1234', ETag: '"x"' };
  res.statusCode = 200;
  res.headersSent = false;
  res.writableEnded = false;
  res.body = null;
  res.destroyed = false;
  res.removeHeader = (h) => { delete res.headers[h]; };
  res.setHeader = (h, v) => { res.headers[h] = v; };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; res.writableEnded = true; return res; };
  res.destroy = () => { res.destroyed = true; };
  // pipe() target surface
  res.write = () => true;
  res.end = () => { res.writableEnded = true; };
  res.on = EventEmitter.prototype.on.bind(res);
  res.emit = EventEmitter.prototype.emit.bind(res);
  return res;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

describe('pipeStreamToResponse (#1128)', () => {
  it('turns a missing file into a 404 instead of an unhandled error', async () => {
    const missing = path.join(os.tmpdir(), `picpeak-not-here-${Date.now()}.jpg`);
    const res = makeRes();

    pipeStreamToResponse(stream_(missing), res, { context: 'thumbnail for photo 1' });
    await settle();

    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'File not found' });
  });

  // How this test discriminates, since the failure mode is a process-level
  // one: replacing the call above with a bare `stream.pipe(res)` — what the
  // thumbnail route did — makes jest fail this suite on the unhandled 'error'
  // event before either assertion runs. Verified by doing exactly that.
  // Catching the throw with a process.on('uncaughtException') listener does
  // NOT work here and would be theatre: the runner installs its own handling,
  // so such a listener never sees it and the assertion could never fail.
  function stream_(p) { return fs.createReadStream(p); }

  it('strips every header that described the file it can no longer send', async () => {
    const res = makeRes();
    // What the image and zip routes actually stage before streaming.
    res.headers = {
      'Content-Length': '1234',
      ETag: '"x"',
      'Content-Type': 'image/jpeg',
      'Content-Disposition': 'attachment; filename="gallery.zip"',
      'Cache-Control': 'private, max-age=1800',
    };
    const stream = fs.createReadStream(path.join(os.tmpdir(), `gone-${Date.now()}.jpg`));

    pipeStreamToResponse(stream, res);
    await settle();

    expect(res.headers['Content-Length']).toBeUndefined();
    expect(res.headers.ETag).toBeUndefined();
    // Express does NOT overwrite an existing Content-Type, so leaving it makes
    // res.json() emit JSON labelled image/jpeg — or a corrupt .zip download.
    expect(res.headers['Content-Type']).toBeUndefined();
    expect(res.headers['Content-Disposition']).toBeUndefined();
  });

  it('does not let a transient 404 be cached as a broken tile', async () => {
    const res = makeRes();
    // The thumbnail route stages 30 minutes; the hero route an hour.
    res.headers = { 'Cache-Control': 'private, max-age=1800' };
    const stream = fs.createReadStream(path.join(os.tmpdir(), `gone3-${Date.now()}.jpg`));

    pipeStreamToResponse(stream, res);
    await settle();

    // The regeneration race is transient by definition: the tier exists moments
    // later. Caching this 404 would keep the tile broken long after the file is
    // back — the opposite of what this helper is for.
    expect(res.headers['Cache-Control']).toBe('no-store');
  });

  it('honours a caller that wants a different missing-status', async () => {
    const res = makeRes();
    const stream = fs.createReadStream(path.join(os.tmpdir(), `gone2-${Date.now()}.zip`));

    pipeStreamToResponse(stream, res, { missingStatus: 410 });
    await settle();

    expect(res.statusCode).toBe(410);
  });

  it('destroys the response instead of rewriting a status that is already sent', async () => {
    const res = makeRes();
    res.headersSent = true;

    const stream = new Readable({ read() {} });
    pipeStreamToResponse(stream, res, { context: 'photo 9' });
    stream.emit('error', Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    await settle();

    // Once bytes are on the wire a 404 is not available; a truncated image the
    // client would cache is worse than a broken connection.
    expect(res.destroyed).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBeNull();
  });

  it('reports a non-ENOENT failure as a 500 rather than a 404', async () => {
    const res = makeRes();
    const stream = new Readable({ read() {} });

    pipeStreamToResponse(stream, res);
    stream.emit('error', Object.assign(new Error('disk exploded'), { code: 'EIO' }));
    await settle();

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to serve file' });
  });

  it('releases the source when the client hangs up mid-download', async () => {
    const res = makeRes();
    let destroyed = false;
    const stream = new Readable({ read() {}, destroy(err, cb) { destroyed = true; cb(err); } });

    pipeStreamToResponse(stream, res);
    res.emit('close');
    await settle();

    // Otherwise an abandoned grid leaks one open fd per tile.
    expect(destroyed).toBe(true);
  });
});

/**
 * Issue 2130: routes await storage.get() and only then call the helper. These
 * run against a REAL http server, because what matters is Node's own
 * ServerResponse state (`destroyed`, the 'close' event having already fired)
 * at the moment the stream arrives — a hand-rolled res would assert whatever
 * the fake says.
 */
describe('pipeStreamToResponse — client already gone (issue 2130)', () => {
  const http = require('http');

  /** A storage body that records whether it was released. */
  function trackedSource(chunks = []) {
    const src = new Readable({ read() {} });
    src.released = new Promise((resolve) => src.once('close', resolve));
    for (const c of chunks) src.push(c);
    return src;
  }

  // Closed in afterEach, so a failing assertion cannot leave a listener that
  // keeps jest from exiting.
  let servers = [];
  function withServer(handler) {
    const server = http.createServer(handler);
    servers.push(server);
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
  }

  afterEach(async () => {
    await Promise.all(servers.map((server) => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(resolve);
    })));
    servers = [];
  });

  it('destroys a stream that arrives after the client aborted', async () => {
    let source;
    let piped;
    const piping = new Promise((resolve) => { piped = resolve; });
    const server = await withServer(async (req, res) => {
      // The delayed get(): resolve only once the client has hung up.
      await new Promise((resolve) => res.once('close', resolve));
      source = trackedSource();
      pipeStreamToResponse(source, res, { context: 'delayed get' });
      piped();
    });

    const req = http.get({ port: server.address().port, host: '127.0.0.1', path: '/' });
    req.on('error', () => {});
    setTimeout(() => req.destroy(), 20);
    await piping;

    // Before the fix this never resolved: 'close' had already fired, so the
    // helper's close listener was never called and the body stayed open.
    await expect(Promise.race([
      source.released.then(() => 'released'),
      new Promise((resolve) => setTimeout(() => resolve('leaked'), 500)),
    ])).resolves.toBe('released');
    expect(source.destroyed).toBe(true);
  });

  it('destroys the stream when the client disconnects mid-body', async () => {
    let source;
    const server = await withServer((req, res) => {
      res.setHeader('Content-Length', 1000);
      source = trackedSource([Buffer.alloc(100, 1)]);
      pipeStreamToResponse(source, res, { context: 'mid-body' });
    });

    await new Promise((resolve) => {
      const req = http.get({ port: server.address().port, host: '127.0.0.1', path: '/' }, (resp) => {
        resp.once('data', () => { req.destroy(); resolve(); });
      });
      req.on('error', () => {});
    });

    await expect(Promise.race([
      source.released.then(() => 'released'),
      new Promise((resolve) => setTimeout(() => resolve('leaked'), 500)),
    ])).resolves.toBe('released');
  });

  it('destroys the stream of a pipelined request whose queued response never got the socket', async () => {
    const net = require('net');
    let source;
    let piped;
    const piping = new Promise((resolve) => { piped = resolve; });
    let bothArrived;
    const arrived = new Promise((resolve) => { bothArrived = resolve; });
    const server = await withServer(async (req, res) => {
      if (req.url === '/first') return; // holds the socket; never answers
      bothArrived();
      await new Promise((resolve) => req.socket.once('close', resolve));
      // Queued behind /first, so Node never gave this response the socket:
      // it is not destroyed and will never see 'close'.
      source = trackedSource();
      pipeStreamToResponse(source, res, { context: 'pipelined' });
      piped();
    });

    const client = net.connect(server.address().port, '127.0.0.1');
    client.on('error', () => {});
    client.write('GET /first HTTP/1.1\r\nHost: x\r\n\r\nGET /second HTTP/1.1\r\nHost: x\r\n\r\n');
    await arrived;
    client.destroy();
    await piping;

    await expect(Promise.race([
      source.released.then(() => 'released'),
      new Promise((resolve) => setTimeout(() => resolve('leaked'), 500)),
    ])).resolves.toBe('released');
  });

  it('serves a completed response exactly as before', async () => {
    const payload = Buffer.from('a full image body');
    const server = await withServer((req, res) => {
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Content-Length', payload.length);
      pipeStreamToResponse(Readable.from([payload]), res, { context: 'normal' });
    });

    const { status, type, body } = await new Promise((resolve, reject) => {
      http.get({ port: server.address().port, host: '127.0.0.1', path: '/' }, (resp) => {
        const parts = [];
        resp.on('data', (c) => parts.push(c));
        resp.on('end', () => resolve({
          status: resp.statusCode, type: resp.headers['content-type'], body: Buffer.concat(parts),
        }));
      }).on('error', reject);
    });

    expect(status).toBe(200);
    expect(type).toBe('image/jpeg');
    expect(body.equals(payload)).toBe(true);
  });

  it('releases the stream instead of writing into an already-ended response', async () => {
    const res = makeRes();
    res.writableEnded = true;
    const writes = [];
    res.write = (c) => { writes.push(c); return true; };
    const stream = new Readable({ read() {} });
    stream.push(Buffer.from('late bytes'));

    pipeStreamToResponse(stream, res);
    await settle();

    expect(stream.destroyed).toBe(true);
    expect(writes).toHaveLength(0);
  });

  it('does not answer a destroyed response when the released stream errors', async () => {
    const res = makeRes();
    res.destroyed = true;
    const stream = new Readable({ read() {} });

    pipeStreamToResponse(stream, res);
    stream.emit('error', Object.assign(new Error('aborted'), { code: 'ECONNRESET' }));
    await settle();

    expect(stream.destroyed).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBeNull();
  });
});

// The admin photo/thumbnail/preview/download routes and the OG cover used to
// pipe the storage stream straight into res, with neither the abort release
// above nor the #1128 error handler. Pin that they go through the helper.
describe('storage streams reach the response through the helper (issue 2130)', () => {
  it.each([
    'src/routes/adminPhotos.js',
    'src/services/galleryOgService.js',
  ])('%s has no raw .pipe(res)', (rel) => {
    const src = fs.readFileSync(path.join(__dirname, '../..', rel), 'utf8');
    expect(src).not.toMatch(/\.pipe\(res\)/);
    expect(src).toMatch(/pipeStreamToResponse\(/);
  });
});
