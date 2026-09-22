/**
 * Evidence encryption (#1446): round trip, tamper detection, the key file
 * created on first use, the env override, and a value from another key.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

let tmp;
let fieldEncryption;
const prev = { storage: process.env.STORAGE_PATH, key: process.env.PICPEAK_EVIDENCE_KEY };

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-evidence-'));
  process.env.STORAGE_PATH = tmp;
  delete process.env.PICPEAK_EVIDENCE_KEY;
  jest.resetModules();
  fieldEncryption = require('../../src/utils/fieldEncryption');
});

afterAll(() => {
  if (prev.storage === undefined) delete process.env.STORAGE_PATH; else process.env.STORAGE_PATH = prev.storage;
  if (prev.key === undefined) delete process.env.PICPEAK_EVIDENCE_KEY; else process.env.PICPEAK_EVIDENCE_KEY = prev.key;
});

test('values round-trip and each encryption is different', () => {
  const a = fieldEncryption.encrypt('203.0.113.7');
  const b = fieldEncryption.encrypt('203.0.113.7');
  expect(a).toMatch(/^v1:[0-9a-f]{8}:/);
  expect(a).not.toBe(b);
  expect(fieldEncryption.decrypt(a)).toBe('203.0.113.7');
  expect(fieldEncryption.encrypt('')).toBeNull();
  expect(fieldEncryption.decrypt(null)).toBeNull();
});

test('the status says where the key comes from without creating one', () => {
  expect(fieldEncryption.keyStatus()).toEqual({ source: 'none', keyId: null });
  expect(fs.existsSync(path.join(tmp, 'business-docs', 'keys', 'evidence.key'))).toBe(false);
  fieldEncryption.encrypt('x');
  expect(fieldEncryption.keyStatus()).toEqual({ source: 'file', keyId: expect.stringMatching(/^[0-9a-f]{8}$/) });
  process.env.PICPEAK_EVIDENCE_KEY = 'b'.repeat(64);
  expect(fieldEncryption.keyStatus().source).toBe('env');
  delete process.env.PICPEAK_EVIDENCE_KEY;
});

test('the key file is created once, private, under business-docs', () => {
  fieldEncryption.encrypt('x');
  const file = path.join(tmp, 'business-docs', 'keys', 'evidence.key');
  expect(fs.readFileSync(file, 'utf8')).toMatch(/^[0-9a-f]{64}$/);
  if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  expect(fieldEncryption.keyInfo()).toEqual({ keyId: expect.stringMatching(/^[0-9a-f]{8}$/), source: 'file' });
});

test('a changed value is refused, and so is one from another key', () => {
  const stored = fieldEncryption.encrypt('Anna Muster');
  const [v, id, body] = stored.split(':');
  const [iv, tag, ct] = body.split('.');
  const flipped = Buffer.from(ct, 'base64url');
  flipped[0] ^= 1;
  expect(() => fieldEncryption.decrypt(`${v}:${id}:${iv}.${tag}.${flipped.toString('base64url')}`)).toThrow();

  // A key nobody holds any more.
  const foreign = stored.replace(/^v1:[0-9a-f]{8}:/, 'v1:deadbeef:');
  expect(() => fieldEncryption.decrypt(foreign)).toThrow(/different evidence key/);
  expect(fieldEncryption.tryDecrypt(foreign)).toBeNull();

  // Setting the env key keeps the generated file readable as an old key
  // (#1446 key ring), so evidence doesn't go blank before the rotation runs.
  process.env.PICPEAK_EVIDENCE_KEY = 'a'.repeat(64);
  fieldEncryption._resetForTests();
  expect(fieldEncryption.keyInfo().source).toBe('env');
  expect(fieldEncryption.decrypt(stored)).toBe('Anna Muster');
  expect(fieldEncryption.encrypt('x').startsWith(`v1:${fieldEncryption.keyInfo().keyId}:`)).toBe(true);
});

test('a key with a character missing is refused, a passphrase is not', () => {
  // Deriving from a near-miss would quietly produce a DIFFERENT key: the
  // evidence already on disk stops opening, and new evidence is written under
  // a key nobody meant to use. A passphrase is not a near-miss — `openssl
  // rand -base64 48` is 64 base64 characters, nowhere near the 43 that decode
  // to 32 bytes.
  const crypto = require('crypto');
  for (const near of ['a'.repeat(63), 'a'.repeat(65), crypto.randomBytes(32).toString('base64').slice(0, 42)]) {
    process.env.PICPEAK_EVIDENCE_KEY = near;
    fieldEncryption._resetForTests();
    expect(() => fieldEncryption.encrypt('x')).toThrow(/character missing/);
    expect(fieldEncryption.keyProblemAtBoot()).toMatch(/character missing/);
  }
  for (const fine of ['a'.repeat(64), crypto.randomBytes(32).toString('base64'),
    crypto.randomBytes(48).toString('base64'), 'a long passphrase nobody would mistake for a key']) {
    process.env.PICPEAK_EVIDENCE_KEY = fine;
    fieldEncryption._resetForTests();
    expect(fieldEncryption.decrypt(fieldEncryption.encrypt('Anna'))).toBe('Anna');
    expect(fieldEncryption.keyProblemAtBoot()).toBeNull();
  }
  delete process.env.PICPEAK_EVIDENCE_KEY;
});

test('a stored value names the key it was written under', () => {
  // System Health compares this with the key in use, so a rotated or restored
  // key shows up as a mismatch instead of as blank names on contracts.
  const stored = fieldEncryption.encrypt('Anna Muster');
  expect(fieldEncryption.keyIdOf(stored)).toBe(fieldEncryption.keyInfo().keyId);
  expect(fieldEncryption.keyIdOf('not encrypted')).toBeNull();
  expect(fieldEncryption.keyIdOf(null)).toBeNull();
});

test('emails hash the same whatever the case or spacing', () => {
  expect(fieldEncryption.hashEmail(' Anna@Example.com ')).toBe(fieldEncryption.hashEmail('anna@example.com'));
});
