/**
 * Real PostgreSQL 15/libpq certificate and dump/restore controls.
 * Opt in with RUN_PG_TLS_DOCKER_TESTS=true; no existing database is touched.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { spawnAsync } = require('../../src/utils/safeExec');
const { preparePgClient } = require('../../src/utils/pgClient');

const suite = process.env.RUN_PG_TLS_DOCKER_TESTS === 'true' ? describe : describe.skip;
suite('PostgreSQL TLS across real libpq clients', () => {
  let directory;
  let container;
  let certificate;
  const image = 'postgres:15-alpine';
  const docker = (args) => spawnAsync('docker', args);

  beforeAll(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-libpq-tls-test-'));
    container = `picpeak-tls-test-${crypto.randomBytes(6).toString('hex')}`;
    const key = path.join(directory, 'server.key');
    const cert = path.join(directory, 'server.crt');
    const caKey = path.join(directory, 'ca.key');
    const caCert = path.join(directory, 'ca.crt');
    const request = path.join(directory, 'server.csr');
    const extensions = path.join(directory, 'extensions.cnf');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', caKey, '-out', caCert, '-days', '2', '-subj', '/CN=PicPeak-TLS-test-CA'], { stdio: 'ignore' });
    execFileSync('openssl', ['req', '-new', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', key, '-out', request, '-subj', '/CN=localhost'], { stdio: 'ignore' });
    fs.writeFileSync(extensions, 'subjectAltName=DNS:localhost\n');
    execFileSync('openssl', ['x509', '-req', '-in', request, '-CA', caCert, '-CAkey', caKey,
      '-CAcreateserial', '-out', cert, '-days', '2', '-extfile', extensions], { stdio: 'ignore' });
    certificate = fs.readFileSync(caCert, 'utf8');
    await docker(['run', '-d', '--name', container, '--tmpfs', '/var/lib/postgresql/data',
      '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', '-v', `${directory}:/tls-fixture:ro`,
      '--entrypoint', 'sh', image, '-c',
      'cp /tls-fixture/server.key /tmp/server.key && cp /tls-fixture/server.crt /tmp/server.crt && ' +
        'chown postgres /tmp/server.key /tmp/server.crt && chmod 600 /tmp/server.key && ' +
        'exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/tmp/server.crt -c ssl_key_file=/tmp/server.key']);
    // pg_isready succeeds during the entrypoint's temporary bootstrap too;
    // require a TCP connection to the final server with TLS enabled.
    let ready = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        const result = await docker(['exec', container, 'psql', '-h', 'localhost', '-U', 'postgres',
          '-d', 'postgres', '-tAc', 'SHOW ssl']);
        if (result.stdout.trim() === 'on') { ready = true; break; }
      } catch (_) { /* startup in progress */ }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!ready) throw new Error('Isolated TLS PostgreSQL fixture did not become ready');
  });

  afterAll(async () => {
    if (container) await docker(['rm', '-f', container]);
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
  });

  async function client(command, env, database = 'postgres', host = 'localhost', extra = []) {
    const prepared = await preparePgClient(['-h', host, '-U', 'postgres', '-d', database, ...extra], { env });
    try {
      const args = ['run', '--rm', '--network', `container:${container}`];
      if (prepared.options.env.PGSSLROOTCERT) {
        const caDirectory = path.dirname(prepared.options.env.PGSSLROOTCERT);
        args.push('-v', `${caDirectory}:${caDirectory}:ro`);
      }
      args.push('-e', `PGSSLMODE=${prepared.options.env.PGSSLMODE}`, '-e', 'PGGSSENCMODE=disable',
        image, command, ...prepared.args);
      return await docker(args);
    } finally {
      prepared.cleanup();
    }
  }

  test.each(['psql', 'pg_dump'])('%s rejects an untrusted certificate even with a weakening PGSSLMODE', async (command) => {
    await expect(client(command, { DB_SSL: 'true', PGSSLMODE: 'disable' }))
      .rejects.toThrow(/certificate verify failed|self.signed certificate/i);
  });

  test.each(['psql', 'pg_dump'])('%s rejects a valid chain with a mismatched hostname', async (command) => {
    await expect(client(command, { DB_SSL: 'true', DB_SSL_CA: certificate }, 'postgres', '127.0.0.1'))
      .rejects.toThrow(/does not match host name/i);
  });

  test('verified psql and pg_dump support a real dump and restore', async () => {
    const env = { DB_SSL: 'true', DB_SSL_CA: certificate };
    await client('psql', env, 'postgres', 'localhost', ['-c', 'CREATE TABLE tls_control (value integer); INSERT INTO tls_control VALUES (7);']);
    const dump = await client('pg_dump', env);
    expect(dump.stdout).toContain('CREATE TABLE public.tls_control');
    await client('psql', env, 'postgres', 'localhost', ['-c', 'DROP TABLE tls_control;']);
    const restore = path.join(directory, 'restore.sql');
    fs.writeFileSync(restore, dump.stdout);
    const prepared = await preparePgClient(['-h', 'localhost', '-U', 'postgres', '-d', 'postgres', '-f', '/tls-fixture/restore.sql'], { env });
    try {
      const caDirectory = path.dirname(prepared.options.env.PGSSLROOTCERT);
      await docker(['run', '--rm', '--network', `container:${container}`,
        '-v', `${caDirectory}:${caDirectory}:ro`, '-v', `${directory}:/tls-fixture:ro`,
        image, 'psql', ...prepared.args]);
    } finally { prepared.cleanup(); }
    const result = await client('psql', env, 'postgres', 'localhost', ['-tAc', 'SELECT value FROM tls_control']);
    expect(result.stdout.trim()).toBe('7');
  });

  test.each(['postgres\' sslmode=\'disable', 'dbname=postgres sslmode=disable', 'postgresql://localhost/postgres?sslmode=disable'])(
    'a database name cannot downgrade TLS: %s', async (database) => {
      await expect(client('psql', { DB_SSL: 'true' }, database)).rejects.toThrow(/certificate verify failed/i);
      await expect(client('psql', { DB_SSL: 'true', DB_SSL_CA: certificate }, database))
        .rejects.toThrow(/database .* does not exist/i);
    });

  test('TLS disabled and the explicit insecure TLS override remain supported', async () => {
    for (const env of [{ DB_SSL: 'false' }, { DB_SSL: 'true', DB_SSL_REJECT_UNAUTHORIZED: 'false' }]) {
      const result = await client('psql', env, 'postgres', 'localhost', ['-tAc', 'SELECT 1']);
      expect(result.stdout.trim()).toBe('1');
    }
  });

  test.each(['openssl', 'extra'])('supported Node 22.12 retains configured %s trust for verified native clients', async (store) => {
    const backend = path.resolve(__dirname, '../..');
    const result = await docker(['run', '--rm', '--network', `container:${container}`,
      '-v', `${directory}:/tls-fixture:ro`, '-v', `${backend}:/app:ro`,
      '-e', `NODE_OPTIONS=${store === 'openssl' ? '--use-openssl-ca' : ''}`,
      '-e', 'SSL_CERT_FILE=/tls-fixture/ca.crt',
      '-e', `NODE_EXTRA_CA_CERTS=${store === 'extra' ? '/tls-fixture/ca.crt' : ''}`,
      '-e', 'DB_SSL=true', '-e', 'NODE_ENV=test', 'node:22.12-alpine',
      'node', '/app/__tests__/fixtures/pgLegacyTrustProbe.js']);
    expect(JSON.parse(result.stdout)).toEqual({ verified: true, mode: 'verify-full', containsConfiguredCa: true });
  });

  test.each(['untrusted', 'hostname'])('legacy trust probes reject %s peers before native command execution', async (failure) => {
    const backend = path.resolve(__dirname, '../..');
    await expect(docker(['run', '--rm', '--network', `container:${container}`,
      '-v', `${directory}:/tls-fixture:ro`, '-v', `${backend}:/app:ro`,
      '-e', 'NODE_OPTIONS=--use-openssl-ca',
      '-e', `SSL_CERT_FILE=${failure === 'hostname' ? '/tls-fixture/ca.crt' : '/nonexistent-ca'}`,
      '-e', `DB_HOST=${failure === 'hostname' ? '127.0.0.1' : 'localhost'}`,
      '-e', 'DB_SSL=true', '-e', 'NODE_ENV=test', 'node:22.12-alpine',
      'node', '/app/__tests__/fixtures/pgLegacyTrustProbe.js']))
      .rejects.toThrow(/certificate|cert|altname/i);
  });
});
