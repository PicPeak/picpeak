// Tiny dev-only webhook receiver. Logs every request as one JSON line per
// hit so the E2E spec can poll the log file (or hit GET /requests to read
// from memory). Holds the last 200 requests in a ring buffer.
//
// Endpoints:
//   POST /        — accept any webhook; records and returns 200
//   GET  /requests — returns the ring buffer as JSON
//   POST /reset   — clear the ring buffer
//   GET  /health  — 200 ok
//
// Configurable response status via FORCE_STATUS env (e.g. 500 to test retries).

const http = require('http');

const PORT = parseInt(process.env.PORT || '8888', 10);
const RING_SIZE = parseInt(process.env.RING_SIZE || '200', 10);
const FORCE_STATUS = parseInt(process.env.FORCE_STATUS || '200', 10);

const ring = [];

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > 1024 * 1024) {
        reject(new Error('payload too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  if (req.method === 'GET' && req.url === '/requests') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(ring));
    return;
  }

  if (req.method === 'POST' && req.url === '/reset') {
    ring.length = 0;
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('cleared');
    return;
  }

  // Treat every other request as a webhook delivery to record.
  let body = '';
  try {
    body = await readBody(req);
  } catch (err) {
    res.writeHead(413, { 'Content-Type': 'text/plain' });
    res.end(err.message);
    return;
  }

  const entry = {
    receivedAt: new Date().toISOString(),
    method: req.method,
    url: req.url,
    headers: req.headers,
    body,
  };
  ring.push(entry);
  if (ring.length > RING_SIZE) ring.shift();

  // Log a single line so docker logs gives a quick readable trace.
  process.stdout.write(
    `[webhook-receiver] ${req.method} ${req.url} sig=${
      req.headers['x-picpeak-signature'] || '-'
    } type=${(() => {
      try { return JSON.parse(body)?.type || '-'; } catch { return '-'; }
    })()}\n`
  );

  res.writeHead(FORCE_STATUS, { 'Content-Type': 'text/plain' });
  res.end(FORCE_STATUS >= 200 && FORCE_STATUS < 300 ? 'ok' : 'forced-failure');
});

server.listen(PORT, () => {
  process.stdout.write(`webhook-receiver listening on :${PORT}\n`);
});
