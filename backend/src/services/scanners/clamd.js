/**
 * clamd scanner for customer documents (#1444, plan slice 8).
 *
 * Speaks clamd's INSTREAM command over TCP with `net` — no dependency: the
 * file goes over as length-prefixed chunks, a zero-length chunk ends it, and
 * clamd answers `stream: OK` or `stream: <signature> FOUND`.
 *
 * Configuration (env):
 *   CLAMAV_HOST        clamd host. Unset → no scanner is registered.
 *   CLAMAV_PORT        default 3310
 *   CLAMAV_TIMEOUT_MS  default 30000 — connect plus the whole exchange
 *   CLAMAV_MAX_BYTES   default 26214400 (25 MiB), clamd's own default
 *                      StreamMaxLength. A larger file is not sent — clamd
 *                      would refuse it — and stays `pending`, so keep this at
 *                      least as large as the upload cap.
 *
 * Verdicts: OK → 'clean', FOUND → 'rejected'. Anything else — a timeout, a
 * refused connection, an ERROR line, a file over the limit — is 'pending':
 * a scan that did not finish never makes a file available.
 *
 * Health for System Health (configured / reachable / last success) is kept
 * in memory per process.
 */

const fs = require('fs');
const net = require('net');
const logger = require('../../utils/logger');

const CHUNK = 64 * 1024;

const state = { lastSuccessAt: null, lastError: null, lastErrorAt: null };

function config() {
  const host = (process.env.CLAMAV_HOST || '').trim();
  const num = (v, d) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : d;
  };
  return {
    host,
    port: num(process.env.CLAMAV_PORT, 3310),
    timeoutMs: num(process.env.CLAMAV_TIMEOUT_MS, 30000),
    maxBytes: num(process.env.CLAMAV_MAX_BYTES, 25 * 1024 * 1024),
  };
}

const isConfigured = () => !!config().host;

/** What went wrong, without the host or address in it (System Health shows it). */
function classify(err) {
  const code = err && err.code;
  if (/timed out/i.test(err && err.message)) return 'timeout';
  if (code === 'ECONNREFUSED') return 'refused';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'unresolved';
  if (/answered/i.test(err && err.message)) return 'scanner_error';
  return 'error';
}

/**
 * Open a connection, run `exchange(socket)` and resolve with clamd's reply
 * (up to the terminating NUL). Rejects on timeout, connection errors and a
 * reply that never ends.
 */
function talk(exchange, { host, port, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const chunks = [];
    let settled = false;
    const done = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err); else resolve(value);
    };
    const timer = setTimeout(() => done(new Error('clamd timed out')), timeoutMs);
    socket.on('error', (err) => done(err));
    socket.on('data', (data) => {
      chunks.push(data);
      const reply = Buffer.concat(chunks);
      const end = reply.indexOf(0);
      if (end !== -1) done(null, reply.subarray(0, end).toString('utf8').trim());
    });
    socket.on('end', () => {
      const reply = Buffer.concat(chunks).toString('utf8').replace(/\0/g, '').trim();
      if (reply) done(null, reply); else done(new Error('clamd closed the connection without an answer'));
    });
    socket.on('connect', () => {
      Promise.resolve(exchange(socket)).catch((err) => done(err));
    });
  });
}

async function streamFile(socket, localPath) {
  const write = (buf) => new Promise((resolve, reject) => {
    socket.write(buf, (err) => (err ? reject(err) : resolve()));
  });
  await write(Buffer.from('zINSTREAM\0', 'latin1'));
  const stream = fs.createReadStream(localPath, { highWaterMark: CHUNK });
  for await (const chunk of stream) {
    const size = Buffer.alloc(4);
    size.writeUInt32BE(chunk.length, 0);
    await write(size);
    await write(chunk);
  }
  await write(Buffer.alloc(4)); // zero-length chunk: end of stream
}

/**
 * The scanner documentScanService.registerScanner takes.
 * @param {string} localPath
 * @returns {Promise<'clean'|'rejected'|'pending'>}
 */
async function scan(localPath) {
  const cfg = config();
  if (!cfg.host) return 'pending';
  const { size } = await fs.promises.stat(localPath);
  if (size > cfg.maxBytes) {
    logger.warn('File larger than CLAMAV_MAX_BYTES; left pending', { size, maxBytes: cfg.maxBytes });
    return 'pending';
  }
  try {
    const reply = await talk((socket) => streamFile(socket, localPath), cfg);
    if (/^stream: OK$/i.test(reply)) {
      state.lastSuccessAt = new Date().toISOString();
      return 'clean';
    }
    if (/FOUND$/i.test(reply)) {
      state.lastSuccessAt = new Date().toISOString();
      // The signature name is logged; the file name never is.
      logger.warn('clamd found malware in a customer document', { signature: reply.replace(/^stream:\s*/i, '').replace(/\s*FOUND$/i, '') });
      return 'rejected';
    }
    throw new Error(`clamd answered: ${reply.slice(0, 120)}`);
  } catch (err) {
    state.lastError = classify(err);
    state.lastErrorAt = new Date().toISOString();
    logger.warn('clamd scan did not complete; the file stays pending', { error: err.message });
    return 'pending';
  }
}

/** PING, for System Health. Short timeout: the page must not hang on it. */
async function ping(timeoutMs = 2000) {
  const cfg = config();
  if (!cfg.host) return false;
  try {
    const reply = await talk((socket) => socket.write('zPING\0'), { ...cfg, timeoutMs: Math.min(timeoutMs, cfg.timeoutMs) });
    return reply === 'PONG';
  } catch (_) {
    return false;
  }
}

async function health() {
  if (!isConfigured()) return { configured: false, reachable: false, lastSuccessAt: null, lastError: null };
  return {
    configured: true,
    reachable: await ping(),
    lastSuccessAt: state.lastSuccessAt,
    lastError: state.lastError,
    lastErrorAt: state.lastErrorAt,
  };
}

module.exports = { scan, ping, health, isConfigured, config, _state: state };
