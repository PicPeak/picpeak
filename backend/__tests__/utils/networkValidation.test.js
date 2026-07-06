/**
 * Tests for the SSRF guard in `networkValidation.js`.
 *
 * Regression coverage for GHSA-wmjx-pc37-272r — the original `isPrivateIPv6`
 * was a string-prefix check that missed NAT64 (`64:ff9b::/96` per RFC 6052,
 * `64:ff9b:1::/48` per RFC 8215), so a webhook URL like
 * `http://[64:ff9b:1::a9fe:a9fe]/` could reach 169.254.169.254 on instances
 * with NAT64/DNS64 egress.
 */

const { validateExternalUrl, isPrivateIP } = require('../../src/utils/networkValidation');

describe('validateExternalUrl — NAT64 + embedded-IPv4 SSRF', () => {
  describe('NAT64 well-known prefix (RFC 6052, 64:ff9b::/96)', () => {
    test.each([
      ['http://[64:ff9b::a9fe:a9fe]/latest/meta-data/', 'AWS metadata via NAT64 hex'],
      ['http://[64:ff9b::169.254.169.254]/', 'AWS metadata via NAT64 mixed notation'],
      ['http://[64:ff9b::7f00:1]/', 'loopback via NAT64'],
      ['http://[64:ff9b::a00:1]/', '10.0.0.1 via NAT64'],
    ])('blocks %s (%s)', (url) => {
      expect(validateExternalUrl(url).valid).toBe(false);
    });
  });

  describe('NAT64 local-use prefix (RFC 8215, 64:ff9b:1::/48)', () => {
    test.each([
      ['http://[64:ff9b:1::a9fe:a9fe]/', 'AWS metadata via local-use NAT64'],
      ['http://[64:ff9b:1::169.254.169.254]/', 'AWS metadata via mixed notation'],
      ['http://[64:ff9b:1::7f00:1]/', 'loopback via local-use NAT64'],
      ['http://[64:ff9b:1:abcd::1]/', 'arbitrary host inside the /48'],
    ])('blocks %s (%s)', (url) => {
      expect(validateExternalUrl(url).valid).toBe(false);
    });
  });

  describe('IPv4-mapped IPv6 (::ffff:0:0/96)', () => {
    test.each([
      'http://[::ffff:127.0.0.1]/',
      'http://[::ffff:7f00:1]/',
      'http://[::ffff:169.254.169.254]/',
      'http://[::ffff:a9fe:a9fe]/',
      'http://[::ffff:10.0.0.1]/',
    ])('blocks %s', (url) => {
      expect(validateExternalUrl(url).valid).toBe(false);
    });
  });

  describe('deprecated IPv4-compatible IPv6 (::/96)', () => {
    test('blocks ::127.0.0.1', () => {
      expect(validateExternalUrl('http://[::127.0.0.1]/').valid).toBe(false);
    });
    test('blocks ::169.254.169.254', () => {
      expect(validateExternalUrl('http://[::169.254.169.254]/').valid).toBe(false);
    });
  });

  describe('existing IPv6 private-range coverage stays intact', () => {
    test.each([
      'http://[::1]/',
      'http://[fc00::1]/',
      'http://[fd12:3456:789a::1]/',
      'http://[fe80::1]/',
      'http://[feb0::1]/',
      'http://[::]/',
    ])('blocks %s', (url) => {
      expect(validateExternalUrl(url).valid).toBe(false);
    });
  });

  describe('public IPv6 hosts stay allowed', () => {
    test.each([
      'https://[2001:4860:4860::8888]/',
      'https://[2606:4700:4700::1111]/',
      'https://[2a00:1450:4001:830::200e]/',
    ])('allows %s', (url) => {
      expect(validateExternalUrl(url).valid).toBe(true);
    });
  });

  describe('existing IPv4 private-range coverage stays intact', () => {
    test.each([
      'http://127.0.0.1/',
      'http://10.0.0.1/',
      'http://172.16.0.1/',
      'http://192.168.0.1/',
      'http://169.254.169.254/',
      'http://0.0.0.0/',
    ])('blocks %s', (url) => {
      expect(validateExternalUrl(url).valid).toBe(false);
    });
  });

  describe('blocked hostnames', () => {
    test.each([
      'http://localhost/',
      'http://metadata.google.internal/',
    ])('blocks %s', (url) => {
      expect(validateExternalUrl(url).valid).toBe(false);
    });
  });

  describe('fail-closed parsing', () => {
    test('isPrivateIP returns true for non-string', () => {
      expect(isPrivateIP(null)).toBe(true);
      expect(isPrivateIP(undefined)).toBe(true);
      expect(isPrivateIP(42)).toBe(true);
    });
    test('invalid URLs are rejected', () => {
      expect(validateExternalUrl('not a url').valid).toBe(false);
      expect(validateExternalUrl('').valid).toBe(false);
    });
  });
});
