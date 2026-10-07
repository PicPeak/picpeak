/**
 * DB_SSL=true used to mean "encrypt, but accept any certificate", which is
 * TLS without an authenticated peer: whoever can redirect the database
 * connection can impersonate the database (Codex security audit 2026-09-30).
 * Verification must be on by default, with an explicit insecure opt-out.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pgSslFromEnv } = require('../../src/utils/pgConnection');

const ENV_KEYS = ['DB_SSL', 'DB_SSL_CA', 'DB_SSL_REJECT_UNAUTHORIZED'];
const saved = {};

beforeEach(() => { for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
afterEach(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

describe('pgSslFromEnv', () => {
  it('is off unless DB_SSL=true', () => {
    expect(pgSslFromEnv()).toBe(false);
    process.env.DB_SSL = 'false';
    expect(pgSslFromEnv()).toBe(false);
  });

  it('authenticates the peer by default for a bare DB_SSL=true', () => {
    process.env.DB_SSL = 'true';
    expect(pgSslFromEnv()).toEqual({ rejectUnauthorized: true });
  });

  it('verifies against the system store when asked explicitly', () => {
    process.env.DB_SSL = 'true';
    process.env.DB_SSL_REJECT_UNAUTHORIZED = 'true';
    expect(pgSslFromEnv()).toEqual({ rejectUnauthorized: true });
  });

  it('verifies against an inline PEM CA', () => {
    process.env.DB_SSL = 'true';
    process.env.DB_SSL_CA = '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----';
    expect(pgSslFromEnv()).toEqual({ ca: process.env.DB_SSL_CA, rejectUnauthorized: true });
  });

  it('reads a CA file path and verifies against it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-pgca-'));
    const file = path.join(dir, 'ca.pem');
    fs.writeFileSync(file, '-----BEGIN CERTIFICATE-----\nfile\n-----END CERTIFICATE-----');
    try {
      process.env.DB_SSL = 'true';
      process.env.DB_SSL_CA = file;
      expect(pgSslFromEnv()).toEqual({ ca: fs.readFileSync(file, 'utf8'), rejectUnauthorized: true });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lets an explicit false win even with a CA configured', () => {
    process.env.DB_SSL = 'true';
    process.env.DB_SSL_CA = '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----';
    process.env.DB_SSL_REJECT_UNAUTHORIZED = 'false';
    expect(pgSslFromEnv().rejectUnauthorized).toBe(false);
  });

  it('normalizes explicit boolean controls', () => {
    expect(pgSslFromEnv({ DB_SSL: ' TRUE ', DB_SSL_REJECT_UNAUTHORIZED: ' FALSE ' }))
      .toEqual({ rejectUnauthorized: false });
  });

  it.each(['127.0.0.1', '::1'])('pins identity verification for IP host %s', (host) => {
    expect(pgSslFromEnv({ DB_SSL: 'true', DB_HOST: host }))
      .toEqual({ rejectUnauthorized: true, host, checkServerIdentity: expect.any(Function) });
  });

  it.each(['1', 'yes', 'tru'])('rejects a malformed TLS control: %s', (value) => {
    expect(() => pgSslFromEnv({ DB_SSL: value })).toThrow('DB_SSL must be true or false');
    expect(() => pgSslFromEnv({ DB_SSL: 'true', DB_SSL_REJECT_UNAUTHORIZED: value }))
      .toThrow('DB_SSL_REJECT_UNAUTHORIZED must be true or false');
  });

  it('fails closed for an unreadable CA file', () => {
    expect(() => pgSslFromEnv({ DB_SSL: 'true', DB_SSL_CA: '/nonexistent/picpeak-test-ca.pem' })).toThrow();
  });

  it('does not fall back to another trust store for an empty configured CA file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-empty-pgca-'));
    const file = path.join(dir, 'empty.pem');
    try {
      fs.writeFileSync(file, '');
      expect(() => pgSslFromEnv({ DB_SSL: 'true', DB_SSL_CA: file })).toThrow('DB_SSL_CA must contain');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it.each(['development', 'test', 'production'])('pins SSL in the %s Knex configuration', (environment) => {
    const { execFileSync } = require('child_process');
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-knex-tls-'));
    const knexfile = path.resolve(__dirname, '../../knexfile.js');
    try {
      const output = execFileSync(process.execPath,
        ['-e', `process.stdout.write(JSON.stringify(require(${JSON.stringify(knexfile)}).connection.ssl))`],
        { cwd, encoding: 'utf8', env: {
          ...process.env, NODE_ENV: environment, DATABASE_CLIENT: 'pg',
          DB_SSL: 'true', DB_SSL_CA: '', DB_SSL_REJECT_UNAUTHORIZED: '', PGSSLMODE: 'no-verify'
        } });
      expect(JSON.parse(output)).toEqual({ rejectUnauthorized: true });
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
