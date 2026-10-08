const fs = require('fs');
const path = require('path');
const { preparePgClient, withPgClientPolicy } = require('../../src/utils/pgClient');

const cleanups = [];
async function prepare(args = ['-h', 'db.example.test', '-d', 'picpeak'], env = { DB_SSL: 'true' }) {
  const prepared = await preparePgClient(args, { env });
  cleanups.push(prepared.cleanup);
  return prepared;
}
afterEach(() => { cleanups.splice(0).forEach((cleanup) => cleanup()); });

test('bare DB_SSL=true pins verify-full and exports default trust roots for libpq 15', async () => {
  const { args, options } = await prepare(undefined, { DB_SSL: 'true', PGSSLMODE: 'disable', PGSSLROOTCERT: '/wrong/ca' });
  expect(options.env.PGSSLMODE).toBe('verify-full');
  expect(args[3]).toContain('dbname=\'picpeak\' host=\'db.example.test\' sslmode=\'verify-full\'');
  expect(args[3]).toContain(`sslrootcert='${options.env.PGSSLROOTCERT}'`);
  expect(fs.readFileSync(options.env.PGSSLROOTCERT, 'utf8')).toContain('-----BEGIN CERTIFICATE-----');
  expect(fs.statSync(options.env.PGSSLROOTCERT).mode & 0o777).toBe(0o600);
});

test('custom CA text is copied into a private temporary file and cleaned up', async () => {
  const ca = '-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----';
  const prepared = await prepare(undefined, { DB_SSL: 'true', DB_SSL_CA: ca });
  const filename = prepared.options.env.PGSSLROOTCERT;
  expect(fs.readFileSync(filename, 'utf8')).toBe(ca);
  expect(fs.statSync(path.dirname(filename)).mode & 0o777).toBe(0o700);
  prepared.cleanup();
  expect(fs.existsSync(filename)).toBe(false);
});

test.each(['-d', '--dbname', '--dbname=', '-djoined'])('quotes the literal database instead of parsing options (%s)', async (flag) => {
  const database = 'postgresql://attacker/db?sslmode=disable dbname=x\'\\ sslmode=disable';
  const input = flag === '--dbname=' ? [`${flag}${database}`] :
    flag === '-djoined' ? [`-d${database}`] : [flag, database];
  const prepared = await prepare(input);
  const value = prepared.args[prepared.args.length - 1];
  expect(value).toContain('dbname=\'postgresql://attacker/db?sslmode=disable dbname=x\\\'\\\\ sslmode=disable\'');
  expect(value).toContain('sslmode=\'verify-full\'');
});

test('TLS disabled stays compatible with the bundled plaintext database', async () => {
  const { options, args } = await prepare(undefined, { DB_SSL: 'false', PGSSLMODE: 'require' });
  expect(options.env.PGSSLMODE).toBe('disable');
  expect(args[3]).toContain('sslmode=\'disable\'');
  expect(options.env.PGSSLROOTCERT).toBeUndefined();
});

test('the explicit insecure override requires encryption but accepts an untrusted certificate', async () => {
  const { options, args } = await prepare(undefined, {
    DB_SSL: 'true', DB_SSL_REJECT_UNAUTHORIZED: 'false', PGSSLROOTCERT: '/existing/root.crt'
  });
  expect(options.env.PGSSLMODE).toBe('require');
  expect(fs.existsSync(options.env.PGSSLROOTCERT)).toBe(false);
  expect(args[3]).toContain('sslmode=\'require\'');
});

describe('DB_SSL_SERVERNAME', () => {
  const ca = '-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----';

  test('an IP host keeps verify-full: the name is verified, the IP is dialled', async () => {
    const { args, options } = await prepare(['-h', '10.0.0.5', '-d', 'picpeak'],
      { DB_SSL: 'true', DB_SSL_CA: ca, DB_SSL_SERVERNAME: 'db.example.com' });
    expect(args[3]).toContain('host=\'db.example.com\' hostaddr=\'10.0.0.5\' sslmode=\'verify-full\'');
    expect(options.env.PGSSLMODE).toBe('verify-full');
  });

  test('a DNS host that differs from the name falls back to verify-ca', async () => {
    const { args, options } = await prepare(['-h', 'postgres', '-d', 'picpeak'],
      { DB_SSL: 'true', DB_SSL_CA: ca, DB_SSL_SERVERNAME: 'db.example.com' });
    expect(args[3]).toContain('host=\'postgres\' sslmode=\'verify-ca\'');
    expect(args[3]).not.toContain('hostaddr');
    expect(options.env.PGSSLMODE).toBe('verify-ca');
    expect(fs.readFileSync(options.env.PGSSLROOTCERT, 'utf8')).toBe(ca);
  });

  test('a name equal to the host changes nothing', async () => {
    const { args } = await prepare(undefined, { DB_SSL: 'true', DB_SSL_CA: ca, DB_SSL_SERVERNAME: 'db.example.test' });
    expect(args[3]).toContain('host=\'db.example.test\' sslmode=\'verify-full\'');
  });

  test('it never weakens or re-enables anything on its own', async () => {
    const off = await prepare(undefined, { DB_SSL: 'false', DB_SSL_SERVERNAME: 'db.example.com' });
    expect(off.args[3]).toContain('sslmode=\'disable\'');
    const insecure = await prepare(undefined, { DB_SSL: 'true', DB_SSL_REJECT_UNAUTHORIZED: 'false', DB_SSL_SERVERNAME: 'db.example.com' });
    expect(insecure.args[3]).toContain('host=\'db.example.test\' sslmode=\'require\'');
  });
});

test('the final readiness failure shows the client error and the TLS ways out', () => {
  const { spawnSync } = require('child_process');
  const os = require('os');
  const entrypoint = fs.readFileSync(path.resolve(__dirname, '../../wait-for-db.sh'), 'utf8');
  const section = entrypoint.slice(entrypoint.indexOf('host="${DB_HOST:-postgres}"'),
    entrypoint.indexOf('# Final verification'));
  expect(section).toContain('max_attempts=30');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-wait-db-'));
  try {
    // A stand-in for `node scripts/pg-client.js`: config check passes, every probe fails.
    fs.writeFileSync(path.join(dir, 'node'),
      '#!/bin/sh\n[ "$2" = "--check-config" ] && exit 0\necho "psql: error: certificate verify failed" >&2\nexit 2\n', { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const script = path.join(dir, 'wait.sh');
    fs.writeFileSync(script, `set -e\n${section.replace('max_attempts=30', 'max_attempts=2')}`);
    const run = (DB_SSL) => spawnSync('sh', [script], { encoding: 'utf8',
      env: { PATH: `${dir}:${process.env.PATH}`, DB_PASSWORD: 'fixture-secret', DB_SSL } });

    const tls = run(' YES ');
    expect(tls.status).toBe(1);
    expect(tls.stderr).toContain('Failed to connect to PostgreSQL after 2 attempts.');
    expect(tls.stderr).toContain('psql: error: certificate verify failed');
    expect(tls.stderr).toMatch(/DB_SSL_CA.*DB_SSL_REJECT_UNAUTHORIZED=false/);
    expect(tls.stdout + tls.stderr).not.toContain('fixture-secret');

    const plain = run('false');
    expect(plain.stderr).toContain('psql: error: certificate verify failed');
    expect(plain.stderr).not.toContain('DB_SSL_REJECT_UNAUTHORIZED');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test.each([
  ['-h', '/tmp'], ['--host', '/tmp'], ['--host=/tmp'], ['-h/tmp'], ['--host=db.example.test,/tmp'], ['--host=']
])('rejects socket/implicit plaintext host variants with TLS: %j', async (...hostArgs) => {
  await expect(prepare([...hostArgs, '-d', 'picpeak'])).rejects.toThrow('TLS requires a TCP host');
});

test('rejects ambiguous/missing database arguments rather than inheriting connection strings', async () => {
  await expect(prepare(['-d', 'one', '-d', 'two'])).rejects.toThrow('exactly one named database');
  await expect(prepare([])).rejects.toThrow('exactly one named database');
  await expect(prepare(['-d'])).rejects.toThrow('connection values must be strings');
});

test.each(['-h/tmp', '-dbname', '--host=/tmp'])('preserves option-like database names literally: %s', async (database) => {
  const prepared = await prepare(['-h', 'db.example.test', '-d', database, '-c', '-dangerous-looking-sql']);
  expect(prepared.args[3]).toContain(`dbname='${database}' host='db.example.test'`);
  expect(prepared.args[5]).toBe('-dangerous-looking-sql');
});

test.each(['psql', 'pg_dump'])('cleans up CA files after successful and failed %s executions', async (command) => {
  let rootCert;
  const execute = jest.fn(async (_args, options) => {
    rootCert = options.env.PGSSLROOTCERT;
    expect(fs.existsSync(rootCert)).toBe(true);
    return { stdout: 'ok' };
  });
  expect(await withPgClientPolicy(command, ['-d', 'picpeak'], { env: { DB_SSL: 'true' } }, execute))
    .toEqual({ stdout: 'ok' });
  expect(fs.existsSync(rootCert)).toBe(false);
  execute.mockImplementation(async (_args, options) => {
    rootCert = options.env.PGSSLROOTCERT;
    throw new Error('fixture failure');
  });
  await expect(withPgClientPolicy(command, ['-d', 'picpeak'], { env: { DB_SSL: 'true' } }, execute))
    .rejects.toThrow('fixture failure');
  expect(fs.existsSync(rootCert)).toBe(false);
});

test('other commands are not changed by database configuration', async () => {
  const args = ['-d', 'something'];
  const options = { env: { DB_SSL: 'malformed' } };
  const execute = jest.fn(async () => 'unchanged');
  expect(await withPgClientPolicy('sqlite3', args, options, execute)).toBe('unchanged');
  expect(execute).toHaveBeenCalledWith(args, options);
});

test('every startup psql probe goes through the shared policy', () => {
  const entrypoint = fs.readFileSync(path.resolve(__dirname, '../../wait-for-db.sh'), 'utf8');
  expect(entrypoint).toContain('scripts/pg-client.js" psql "$@"');
  expect(entrypoint.match(/PGPASSWORD="\$DB_PASSWORD" pg_client /g)).toHaveLength(5);
  expect(entrypoint).not.toMatch(/PGPASSWORD="\$DB_PASSWORD" psql /);
  expect(entrypoint).toContain('scripts/pg-client.js" --check-config');
});
