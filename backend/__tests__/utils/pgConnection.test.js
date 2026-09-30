/**
 * DB_SSL=true used to mean "encrypt, but accept any certificate", which is
 * TLS without an authenticated peer: whoever can redirect the database
 * connection can impersonate the database (Codex security audit 2026-09-30).
 * Verification is now on whenever the operator gives us a CA or asks for it,
 * and the legacy shape keeps working so existing installs do not break.
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

  it('keeps the legacy accept-anything shape for a bare DB_SSL=true', () => {
    process.env.DB_SSL = 'true';
    expect(pgSslFromEnv()).toEqual({ rejectUnauthorized: false });
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
    process.env.DB_SSL = 'true';
    process.env.DB_SSL_CA = file;
    expect(pgSslFromEnv()).toEqual({ ca: fs.readFileSync(file, 'utf8'), rejectUnauthorized: true });
  });

  it('lets an explicit false win even with a CA configured', () => {
    process.env.DB_SSL = 'true';
    process.env.DB_SSL_CA = '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----';
    process.env.DB_SSL_REJECT_UNAUTHORIZED = 'false';
    expect(pgSslFromEnv().rejectUnauthorized).toBe(false);
  });
});
