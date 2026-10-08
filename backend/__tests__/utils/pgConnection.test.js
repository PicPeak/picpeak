/**
 * DB_SSL=true used to mean "encrypt, but accept any certificate", which is
 * TLS without an authenticated peer: whoever can redirect the database
 * connection can impersonate the database (Codex security audit 2026-09-30).
 * Verification must be on by default, with an explicit insecure opt-out.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pgSslFromEnv, pgTlsNotice, PG_TLS_GUIDANCE } = require('../../src/utils/pgConnection');

const ENV_KEYS = ['DB_SSL', 'DB_SSL_CA', 'DB_SSL_REJECT_UNAUTHORIZED', 'DB_SSL_SERVERNAME'];
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

  // Upgrade safety: these spellings must not stop a boot (review of PR 1852).
  it.each(['1', 'yes', 'on', ' YES ', 'On'])('reads %j as true for both controls', (value) => {
    expect(pgSslFromEnv({ DB_SSL: value })).toEqual({ rejectUnauthorized: true });
    expect(pgSslFromEnv({ DB_SSL: 'true', DB_SSL_REJECT_UNAUTHORIZED: value })).toEqual({ rejectUnauthorized: true });
  });

  it.each(['0', 'no', 'off', ' NO ', 'Off'])('reads %j as false for both controls', (value) => {
    expect(pgSslFromEnv({ DB_SSL: value })).toBe(false);
    expect(pgSslFromEnv({ DB_SSL: 'true', DB_SSL_REJECT_UNAUTHORIZED: value })).toEqual({ rejectUnauthorized: false });
  });

  it.each(['tru', '2', 'enabled', 'y'])('rejects a malformed TLS control: %s', (value) => {
    expect(() => pgSslFromEnv({ DB_SSL: value })).toThrow('DB_SSL must be true or false');
    expect(() => pgSslFromEnv({ DB_SSL: 'true', DB_SSL_REJECT_UNAUTHORIZED: value }))
      .toThrow('DB_SSL_REJECT_UNAUTHORIZED must be true or false');
  });

  describe('DB_SSL_SERVERNAME', () => {
    const certificate = { subject: { CN: 'db.example.com' }, subjectaltname: 'DNS:db.example.com' };

    it.each(['postgres', '10.0.0.5'])('verifies the configured name instead of DB_HOST=%s', (host) => {
      const ssl = pgSslFromEnv({ DB_SSL: 'true', DB_HOST: host, DB_SSL_SERVERNAME: ' db.example.com ' });
      expect(ssl.rejectUnauthorized).toBe(true);
      expect(ssl.servername).toBe('db.example.com');
      // pg passes its own host to the hook; the configured name must win.
      expect(ssl.checkServerIdentity(host, certificate)).toBeUndefined();
      expect(ssl.checkServerIdentity('db.example.com', { ...certificate, subjectaltname: 'DNS:other.example.com', subject: { CN: 'other.example.com' } }))
        .toMatchObject({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
    });

    it('never sends an IP as SNI', () => {
      const ssl = pgSslFromEnv({ DB_SSL: 'true', DB_HOST: 'postgres', DB_SSL_SERVERNAME: '10.0.0.5' });
      expect(ssl.servername).toBeUndefined();
      expect(ssl.checkServerIdentity('postgres', certificate)).toMatchObject({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
    });

    it('is ignored when verification is switched off', () => {
      expect(pgSslFromEnv({ DB_SSL: 'true', DB_SSL_REJECT_UNAUTHORIZED: 'false', DB_SSL_SERVERNAME: 'db.example.com' }))
        .toEqual({ rejectUnauthorized: false });
    });
  });

  describe('boot notice', () => {
    it('stays quiet for a verified connection with its own CA, and with TLS off', () => {
      expect(pgTlsNotice({ rejectUnauthorized: true, ca: 'pem' })).toBeNull();
      expect(pgTlsNotice(false)).toBeNull();
    });

    it('explains the CA when TLS is on without one, and warns when verification is off', () => {
      expect(pgTlsNotice({ rejectUnauthorized: true })).toBe(PG_TLS_GUIDANCE);
      expect(pgTlsNotice({ rejectUnauthorized: false, ca: 'pem' })).toMatch(/verification is explicitly disabled/);
    });

    it.each([
      [{ DB_SSL_CA: '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----' }, 0],
      [{}, 1],
      [{ DB_SSL_REJECT_UNAUTHORIZED: 'false' }, 1],
    ])('pgConnectionFromEnv writes it once per process only when there is one: %j', (extra, lines) => {
      const savedNodeEnv = process.env.NODE_ENV;
      const write = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        Object.assign(process.env, { NODE_ENV: 'production', DB_SSL: 'true' }, extra);
        jest.isolateModules(() => {
          const { pgConnectionFromEnv } = require('../../src/utils/pgConnection');
          pgConnectionFromEnv();
          pgConnectionFromEnv();
        });
        expect(write.mock.calls.filter(([text]) => String(text).startsWith('[db] '))).toHaveLength(lines);
      } finally {
        write.mockRestore();
        process.env.NODE_ENV = savedNodeEnv;
      }
    });
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
