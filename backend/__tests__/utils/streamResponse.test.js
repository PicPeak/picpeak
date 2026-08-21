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

  it('strips the stale Content-Length so the error body is not self-contradictory', async () => {
    const res = makeRes();
    const stream = fs.createReadStream(path.join(os.tmpdir(), `gone-${Date.now()}.jpg`));

    pipeStreamToResponse(stream, res);
    await settle();

    // Both came from a stat that no longer describes anything.
    expect(res.headers['Content-Length']).toBeUndefined();
    expect(res.headers.ETag).toBeUndefined();
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
