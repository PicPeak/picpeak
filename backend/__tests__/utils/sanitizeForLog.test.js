/**
 * Credential redaction for log payloads (GHSA-pgmp / GHSA-r794).
 *
 * Event create/update logged the whole request body. Beyond the plaintext
 * gallery password named in the advisories, the update path also logged
 * `client_share_token` — a LIVE bearer credential for client gallery access,
 * freshly minted by `regenerate_client_token` — and `client_password_hash`.
 */

const { sanitizeForLog, isSensitiveKey } = require('../../src/utils/sanitizeForLog');

describe('sanitizeForLog', () => {
  it('redacts the credentials an event body actually carries', () => {
    const out = sanitizeForLog({
      event_name: 'Wedding',
      password: 'FAKE-PLAINTEXT-PASSWORD',
      client_password: 'FAKE-CLIENT-PASSWORD',
      client_password_hash: 'FAKE-BCRYPT-HASH-PLACEHOLDER',
      client_share_token: 'FAKE-CLIENT-SHARE-TOKEN',
      share_token: 'FAKE-SHARE-TOKEN',
    });

    expect(out.event_name).toBe('Wedding');
    for (const key of ['password', 'client_password', 'client_password_hash',
      'client_share_token', 'share_token']) {
      expect(out[key]).toBe('[redacted]');
    }
    expect(JSON.stringify(out)).not.toContain('FAKE-PLAINTEXT-PASSWORD');
    expect(JSON.stringify(out)).not.toContain('FAKE-CLIENT-SHARE-TOKEN');
  });

  it('redacts nested and array-nested secrets', () => {
    const out = sanitizeForLog({
      smtp: { host: 'mail.example.com', smtp_password: 'p' },
      users: [{ name: 'a', api_key: 'k' }],
    });
    expect(out.smtp.host).toBe('mail.example.com');
    expect(out.smtp.smtp_password).toBe('[redacted]');
    expect(out.users[0].name).toBe('a');
    expect(out.users[0].api_key).toBe('[redacted]');
  });

  it('passes non-objects through and survives cycles', () => {
    expect(sanitizeForLog('plain')).toBe('plain');
    expect(sanitizeForLog(42)).toBe(42);
    expect(sanitizeForLog(null)).toBeNull();

    const cyclic = { name: 'x' };
    cyclic.self = cyclic;
    expect(() => sanitizeForLog(cyclic)).not.toThrow();
    expect(sanitizeForLog(cyclic).self).toBe('[circular]');
  });

  it('matches key names case-insensitively and by fragment', () => {
    expect(isSensitiveKey('Authorization')).toBe(true);
    expect(isSensitiveKey('CLIENT_SHARE_TOKEN')).toBe(true);
    expect(isSensitiveKey('event_name')).toBe(false);
  });
});

/**
 * Codex round 2: sanitizing req.body was not enough. express-validator's
 * errors.array() embeds the SUBMITTED value per field, so a password rejected
 * for being too short was still logged in plaintext.
 */
describe('sanitizeValidationErrors', () => {
  const { sanitizeValidationErrors } = require('../../src/utils/sanitizeForLog');

  it('redacts the submitted value for a password field', () => {
    const out = sanitizeValidationErrors([
      { type: 'field', path: 'password', msg: 'too short', value: 'FAKE-PLAINTEXT-PASSWORD' },
      { type: 'field', path: 'event_name', msg: 'required', value: '' },
    ]);
    expect(out[0].value).toBe('[redacted]');
    expect(out[0].msg).toBe('too short');
    expect(JSON.stringify(out)).not.toContain('FAKE-PLAINTEXT-PASSWORD');
    expect(out[1].value).toBe('');
  });

  it('handles the legacy `param` field name', () => {
    const out = sanitizeValidationErrors([{ param: 'client_password', value: 'FAKE-SECRET' }]);
    expect(out[0].value).toBe('[redacted]');
  });

  it('recurses into object values on non-sensitive fields', () => {
    const out = sanitizeValidationErrors([
      { path: 'config', value: { host: 'h', api_key: 'k' } },
    ]);
    expect(out[0].value.host).toBe('h');
    expect(out[0].value.api_key).toBe('[redacted]');
  });

  it('passes non-arrays through untouched', () => {
    expect(sanitizeValidationErrors(undefined)).toBeUndefined();
  });
});
