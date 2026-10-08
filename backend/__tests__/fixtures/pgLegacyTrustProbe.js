// Executed by the integration suite in a supported older Node runtime.
// No database credentials or PostgreSQL startup packet is sent.
const fs = require('fs');
const net = require('net');
const tls = require('tls');
const { preparePgClient } = require('../../src/utils/pgClient');

async function run() {
  if (typeof tls.getCACertificates === 'function') throw new Error('Expected a legacy Node trust API');
  const host = process.env.DB_HOST || 'localhost';
  const prepared = await preparePgClient(['-h', host, '-p', '5432', '-d', 'postgres'], { env: process.env });
  try {
    const bundle = fs.readFileSync(prepared.options.env.PGSSLROOTCERT, 'utf8');
    await new Promise((resolve, reject) => {
      const socket = net.connect(5432, host);
      socket.once('error', reject);
      socket.once('connect', () => socket.write(Buffer.from([0, 0, 0, 8, 4, 210, 22, 47])));
      socket.once('data', (response) => {
        if (response.toString() !== 'S') { socket.destroy(); reject(new Error('TLS unavailable')); return; }
        const secure = tls.connect({ socket, host, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: true, ca: bundle });
        secure.once('error', reject);
        secure.once('secureConnect', () => {
          const authorized = secure.authorized;
          secure.destroy();
          if (!authorized) reject(new Error('Exported trust did not authenticate the peer'));
          else resolve();
        });
      });
    });
    process.stdout.write(JSON.stringify({ verified: true, mode: prepared.options.env.PGSSLMODE,
      containsConfiguredCa: bundle.includes(fs.readFileSync(process.env.SSL_CERT_FILE, 'utf8').trim()) }));
  } finally { prepared.cleanup(); }
}

run().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
