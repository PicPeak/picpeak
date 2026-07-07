/**
 * Unit tests for mfaService — admin TOTP MFA (#738).
 *
 * Pure unit: no DB, no Express. Exercises the crypto/verification surface
 * directly. JWT_SECRET is set at the top so getEncryptionKey()'s scrypt
 * derivation has key material (the service derives the AES key from
 * MFA_ENCRYPTION_KEY, falling back to JWT_SECRET).
 */

// Must be set BEFORE the service is required — the key is derived lazily per
// call, but keep it explicit and stable so encrypt/decrypt round-trips.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'mfa-unit-test-secret';
delete process.env.MFA_ENCRYPTION_KEY; // ensure we derive from JWT_SECRET

const { authenticator } = require('otplib');
const mfaService = require('../../src/services/mfaService');

describe('mfaService — secret encryption (AES-256-GCM)', () => {
  it('round-trips encrypt → decrypt to the original secret', () => {
    const secret = mfaService.generateSecret();
    const blob = mfaService.encryptSecret(secret);
    expect(blob).toEqual(expect.any(String));
    expect(blob).not.toContain(secret); // stored form is not plaintext
    expect(blob.split('.')).toHaveLength(3); // iv.tag.ciphertext
    expect(mfaService.decryptSecret(blob)).toBe(secret);
  });

  it('produces a different ciphertext each time (random IV) but decrypts identically', () => {
    const secret = mfaService.generateSecret();
    const a = mfaService.encryptSecret(secret);
    const b = mfaService.encryptSecret(secret);
    expect(a).not.toBe(b);
    expect(mfaService.decryptSecret(a)).toBe(secret);
    expect(mfaService.decryptSecret(b)).toBe(secret);
  });

  it('throws when decrypting a malformed blob (wrong segment count)', () => {
    expect(() => mfaService.decryptSecret('garbage')).toThrow();
    expect(() => mfaService.decryptSecret('only.two')).toThrow();
  });

  it('throws when the auth tag / ciphertext is tampered with', () => {
    const secret = mfaService.generateSecret();
    const [iv, tag, ct] = mfaService.encryptSecret(secret).split('.');
    // Flip a character in the ciphertext → GCM auth check must fail.
    const tampered = ct.slice(0, -2) + (ct.slice(-2) === 'AA' ? 'BB' : 'AA');
    expect(() => mfaService.decryptSecret([iv, tag, tampered].join('.'))).toThrow();
  });
});

describe('mfaService — TOTP verification', () => {
  it('accepts a freshly generated code for the plaintext secret', () => {
    const secret = mfaService.generateSecret();
    const code = authenticator.generate(secret);
    expect(mfaService.verifyTotp(code, secret)).toBe(true);
  });

  it('tolerates whitespace in the submitted code', () => {
    const secret = mfaService.generateSecret();
    const code = authenticator.generate(secret);
    expect(mfaService.verifyTotp(` ${code} `, secret)).toBe(true);
  });

  it('rejects a wrong code', () => {
    const secret = mfaService.generateSecret();
    const code = authenticator.generate(secret);
    const wrong = code === '000000' ? '111111' : '000000';
    expect(mfaService.verifyTotp(wrong, secret)).toBe(false);
  });

  it('returns false for empty inputs rather than throwing', () => {
    const secret = mfaService.generateSecret();
    expect(mfaService.verifyTotp('', secret)).toBe(false);
    expect(mfaService.verifyTotp('123456', '')).toBe(false);
    expect(mfaService.verifyTotp(null, secret)).toBe(false);
  });

  it('verifies through the encrypted blob (verifyTotpEncrypted)', () => {
    const secret = mfaService.generateSecret();
    const stored = mfaService.encryptSecret(secret);
    const code = authenticator.generate(secret);
    expect(mfaService.verifyTotpEncrypted(code, stored)).toBe(true);

    const wrong = code === '000000' ? '111111' : '000000';
    expect(mfaService.verifyTotpEncrypted(wrong, stored)).toBe(false);
  });

  it('verifyTotpEncrypted returns false (no throw) for a corrupt blob', () => {
    const secret = mfaService.generateSecret();
    const code = authenticator.generate(secret);
    expect(mfaService.verifyTotpEncrypted(code, 'not-a-valid-blob')).toBe(false);
  });
});

describe('mfaService — otpauth URI / QR', () => {
  it('builds an otpauth:// URI containing issuer, account and secret', () => {
    const secret = mfaService.generateSecret();
    const uri = mfaService.buildOtpauthUri('admin@example.com', secret);
    expect(uri).toMatch(/^otpauth:\/\/totp\//);
    expect(uri).toContain(encodeURIComponent(mfaService.ISSUER));
    expect(uri).toContain(`secret=${secret}`);
  });

  it('builds a PNG data-URL QR for the URI', async () => {
    const secret = mfaService.generateSecret();
    const uri = mfaService.buildOtpauthUri('admin@example.com', secret);
    const qr = await mfaService.buildQrDataUrl(uri);
    expect(qr).toMatch(/^data:image\/png;base64,/);
  });
});

describe('mfaService — recovery codes', () => {
  it('generates 10 distinct plaintext codes and 10 distinct hashes', async () => {
    const { plain, hashed } = await mfaService.generateRecoveryCodes();
    expect(plain).toHaveLength(mfaService.RECOVERY_CODE_COUNT);
    expect(hashed).toHaveLength(mfaService.RECOVERY_CODE_COUNT);
    expect(new Set(plain).size).toBe(10);
    expect(new Set(hashed).size).toBe(10);
    // Hashes are bcrypt, not the plaintext.
    hashed.forEach((h) => expect(h).toMatch(/^\$2[aby]\$/));
    plain.forEach((p) => expect(hashed).not.toContain(p));
  });

  it('formats a raw code into 4-char groups', () => {
    expect(mfaService.formatRecoveryCode('abcdefghij')).toBe('abcd-efgh-ij');
  });

  it('consumes a valid recovery code once and removes it (single-use)', async () => {
    const { plain, hashed } = await mfaService.generateRecoveryCodes();
    const target = plain[3];

    const first = await mfaService.consumeRecoveryCode(target, hashed);
    expect(first.matched).toBe(true);
    expect(first.remainingHashes).toHaveLength(9);

    // Reusing the same code against the reduced set must now fail.
    const reuse = await mfaService.consumeRecoveryCode(target, first.remainingHashes);
    expect(reuse.matched).toBe(false);
    expect(reuse.remainingHashes).toHaveLength(9);
  });

  it('matches case-insensitively and trims whitespace', async () => {
    const { plain, hashed } = await mfaService.generateRecoveryCodes();
    const res = await mfaService.consumeRecoveryCode(`  ${plain[0].toUpperCase()}  `, hashed);
    expect(res.matched).toBe(true);
  });

  it('rejects a wrong code and leaves the hash set unchanged', async () => {
    const { hashed } = await mfaService.generateRecoveryCodes();
    const res = await mfaService.consumeRecoveryCode('zzzz-zzzz-zz', hashed);
    expect(res.matched).toBe(false);
    expect(res.remainingHashes).toHaveLength(10);
  });

  it('handles empty / missing input safely', async () => {
    const { hashed } = await mfaService.generateRecoveryCodes();
    const res = await mfaService.consumeRecoveryCode('', hashed);
    expect(res.matched).toBe(false);
    expect(res.remainingHashes).toBe(hashed);
    const noHashes = await mfaService.consumeRecoveryCode('abcd-efgh-ij', null);
    expect(noHashes.matched).toBe(false);
    expect(noHashes.remainingHashes).toEqual([]);
  });
});

describe('mfaService — parseRecoveryCodes', () => {
  it('parses a JSON string array', () => {
    expect(mfaService.parseRecoveryCodes(JSON.stringify(['a', 'b']))).toEqual(['a', 'b']);
  });
  it('passes an already-array through', () => {
    expect(mfaService.parseRecoveryCodes(['a', 'b'])).toEqual(['a', 'b']);
  });
  it('returns [] for null / garbage / non-array JSON', () => {
    expect(mfaService.parseRecoveryCodes(null)).toEqual([]);
    expect(mfaService.parseRecoveryCodes('{not json')).toEqual([]);
    expect(mfaService.parseRecoveryCodes(JSON.stringify({ a: 1 }))).toEqual([]);
  });
});

describe('mfaService — isEnrolled coercion', () => {
  it('treats true / 1 / "1" as enrolled', () => {
    expect(mfaService.isEnrolled({ two_factor_enabled: true })).toBe(true);
    expect(mfaService.isEnrolled({ two_factor_enabled: 1 })).toBe(true);
    expect(mfaService.isEnrolled({ two_factor_enabled: '1' })).toBe(true);
  });
  it('treats false / 0 / null / missing as not enrolled', () => {
    expect(mfaService.isEnrolled({ two_factor_enabled: false })).toBe(false);
    expect(mfaService.isEnrolled({ two_factor_enabled: 0 })).toBe(false);
    expect(mfaService.isEnrolled({ two_factor_enabled: null })).toBe(false);
    expect(mfaService.isEnrolled({})).toBe(false);
    expect(mfaService.isEnrolled(null)).toBe(false);
  });
});
