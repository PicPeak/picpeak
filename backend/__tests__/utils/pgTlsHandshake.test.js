const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const tls = require('tls');
const { execFileSync } = require('child_process');
const { Client } = require('pg');
const { pgSslFromEnv } = require('../../src/utils/pgConnection');

let directory;
let server;
let certificate;
let port;
let startupMessages = 0;
let context;
let ipContext;
let ipCertificate;
const sockets = new Set();

beforeAll(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-pg-tls-test-'));
  const keyFile = path.join(directory, 'server.key');
  const certFile = path.join(directory, 'server.crt');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyFile, '-out', certFile, '-days', '2', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost'], { stdio: 'ignore' });
  certificate = fs.readFileSync(certFile, 'utf8');
  context = tls.createSecureContext({ key: fs.readFileSync(keyFile), cert: certificate });
  const ipKey = path.join(directory, 'ip.key');
  const ipCert = path.join(directory, 'ip.crt');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', ipKey, '-out', ipCert, '-days', '2', '-subj', '/CN=IP-fixture',
    '-addext', 'subjectAltName=IP:127.0.0.1,IP:::1'], { stdio: 'ignore' });
  ipCertificate = fs.readFileSync(ipCert, 'utf8');
  ipContext = tls.createSecureContext({ key: fs.readFileSync(ipKey), cert: ipCertificate });

  server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.once('data', (request) => {
      // PostgreSQL's SSLRequest must precede every authenticated connection.
      if (request.length !== 8 || request.readInt32BE(4) !== 80877103) {
        startupMessages += 1;
        socket.destroy();
        return;
      }
      socket.write('S');
      const secure = new tls.TLSSocket(socket, { isServer: true, secureContext: context });
      sockets.add(secure);
      secure.on('close', () => sockets.delete(secure));
      secure.on('error', () => {});
      secure.once('data', () => {
        startupMessages += 1;
        // AuthenticationOk and ReadyForQuery are enough for Client.connect.
        secure.write(Buffer.from([82, 0, 0, 0, 8, 0, 0, 0, 0, 90, 0, 0, 0, 5, 73]));
      });
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => { port = server.address().port; resolve(); });
  });
});

afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  if (server) await new Promise((resolve) => server.close(resolve));
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
});

async function connect(env, host = 'localhost') {
  const client = new Client({ host, port, user: 'fixture', database: 'fixture',
    ssl: pgSslFromEnv(env, host), connectionTimeoutMillis: 3000 });
  try { await client.connect(); } finally { await client.end(); }
}

test('default configured TLS rejects an untrusted peer before sending startup/credentials', async () => {
  const before = startupMessages;
  await expect(connect({ DB_SSL: 'true' })).rejects.toThrow(/self.signed|certificate/i);
  expect(startupMessages).toBe(before);
});

test('a trusted CA with the wrong hostname is rejected before startup/credentials', async () => {
  const before = startupMessages;
  await expect(connect({ DB_SSL: 'true', DB_SSL_CA: certificate }, '127.0.0.1'))
    .rejects.toThrow(/not in the cert|altname|IP.*not/i);
  expect(startupMessages).toBe(before);
});

test('private CA and matching hostname preserve legitimate TLS connections', async () => {
  const before = startupMessages;
  await expect(connect({ DB_SSL: 'true', DB_SSL_CA: certificate })).resolves.toBeUndefined();
  expect(startupMessages).toBe(before + 1);
});

test.each(['127.0.0.1', '::1'])('a trusted certificate with matching IP %s remains usable without SNI', async (host) => {
  const before = startupMessages;
  const dnsContext = context;
  try {
    context = ipContext;
    await expect(connect({ DB_SSL: 'true', DB_SSL_CA: ipCertificate }, host)).resolves.toBeUndefined();
    expect(startupMessages).toBe(before + 1);
  } finally {
    context = dnsContext;
  }
});

test('the documented explicit insecure override remains compatible', async () => {
  const before = startupMessages;
  await expect(connect({ DB_SSL: 'true', DB_SSL_REJECT_UNAUTHORIZED: 'false' })).resolves.toBeUndefined();
  expect(startupMessages).toBe(before + 1);
});
