const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnAsync, spawnToFile, spawnFromFile } = require('../../src/utils/safeExec');

let directory;
let env;
beforeAll(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-pg-spawn-test-'));
  // A stand-in client records the actual argv/environment at the spawn sink.
  // Real certificate handshakes are covered separately by pgTlsHandshake.
  const source = `#!${process.execPath}
const fs = require('fs');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({ args: process.argv.slice(2), mode: process.env.PGSSLMODE,
    root: process.env.PGSSLROOTCERT, caExists: fs.existsSync(process.env.PGSSLROOTCERT), input }));
  process.exitCode = Number(process.env.PG_TEST_EXIT || 0);
});
`;
  for (const command of ['psql', 'pg_dump']) {
    fs.writeFileSync(path.join(directory, command), source, { mode: 0o700 });
  }
  env = { ...process.env, PATH: `${directory}${path.delimiter}${process.env.PATH}`,
    DB_SSL: 'true', DB_SSL_CA: '', DB_SSL_REJECT_UNAUTHORIZED: '', PGSSLMODE: 'disable' };
});
afterAll(() => fs.rmSync(directory, { recursive: true, force: true }));

function checkRecord(record) {
  expect(record.mode).toBe('verify-full');
  expect(record.caExists).toBe(true);
  expect(record.args[1]).toContain('dbname=\'picpeak\' host=\'postgres\' sslmode=\'verify-full\'');
  expect(fs.existsSync(record.root)).toBe(false);
}

test('ordinary psql commands get the verified policy at spawn', async () => {
  const result = await spawnAsync('psql', ['-d', 'picpeak'], { env });
  checkRecord(JSON.parse(result.stdout));
});

test('the startup CLI preserves output and uses the same verified policy', async () => {
  const result = await spawnAsync(process.execPath,
    [path.resolve(__dirname, '../../scripts/pg-client.js'), 'psql', '-d', 'picpeak'], { env });
  checkRecord(JSON.parse(result.stdout));
});

test('streaming pg_dump applies the policy and flushes the output file', async () => {
  const output = path.join(directory, 'dump.sql');
  await spawnToFile('pg_dump', ['-d', 'picpeak'], output, { env });
  checkRecord(JSON.parse(fs.readFileSync(output, 'utf8')));
});

test('streaming psql restore applies the policy without changing input', async () => {
  const input = path.join(directory, 'restore.sql');
  fs.writeFileSync(input, 'SELECT 1;\n');
  const result = await spawnFromFile('psql', ['-d', 'picpeak'], input, { env });
  const record = JSON.parse(result.stdout);
  checkRecord(record);
  expect(record.input).toBe('SELECT 1;\n');
});

test.each(['async', 'toFile', 'fromFile'])('failed %s command preserves errors and removes the CA file', async (mode) => {
  const filename = path.join(directory, `failed-${mode}.sql`);
  fs.writeFileSync(filename, 'SELECT 1;\n');
  const options = { env: { ...env, PG_TEST_EXIT: '3' } };
  const run = mode === 'async' ? spawnAsync('psql', ['-d', 'picpeak'], options) :
    mode === 'toFile' ? spawnToFile('pg_dump', ['-d', 'picpeak'], filename, options) :
      spawnFromFile('psql', ['-d', 'picpeak'], filename, options);
  try {
    await run;
    throw new Error('Expected client failure');
  } catch (error) {
    expect(error.code).toBe(3);
    const record = JSON.parse(mode === 'toFile' ? fs.readFileSync(filename, 'utf8') : error.stdout);
    checkRecord(record);
  }
});

test('non-PostgreSQL commands still run with their original arguments', async () => {
  const result = await spawnAsync(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', 'literal'],
    { env: { ...process.env, DB_SSL: 'invalid' } });
  expect(result.stdout).toBe('literal');
});
