/**
 * DNS-resolving SSRF guard (GHSA SSRF cluster: webhook / S3 / rsync / SMTP /
 * IMAP). The literal isPrivateIP check can't see that a public-looking
 * hostname resolves to an internal/metadata IP; isHostAllowed resolves the
 * name and vets every A/AAAA record.
 */
jest.mock('dns', () => {
  const actual = jest.requireActual('dns');
  return { ...actual, promises: { ...actual.promises, lookup: jest.fn() } };
});
const dns = require('dns');
const {
  isHostAllowed,
  validateExternalUrlAsync,
} = require('../../src/utils/networkValidation');

const lookup = dns.promises.lookup;

describe('isHostAllowed', () => {
  beforeEach(() => lookup.mockReset());

  it('rejects a public hostname that resolves to a private IP', async () => {
    lookup.mockResolvedValue([{ address: '10.0.0.5', family: 4 }]);
    expect(await isHostAllowed('evil.example.com')).toBe(false);
  });

  it('rejects when the hostname resolves to the cloud metadata IP', async () => {
    lookup.mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);
    expect(await isHostAllowed('metadata-rebind.example')).toBe(false);
  });

  it('rejects when ANY resolved address is private (rebinding / mixed records)', async () => {
    lookup.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '169.254.169.254', family: 4 },
    ]);
    expect(await isHostAllowed('rebind.example')).toBe(false);
  });

  it('allows a hostname that resolves only to public IPs', async () => {
    lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    expect(await isHostAllowed('example.com')).toBe(true);
  });

  it('fails closed when resolution errors', async () => {
    lookup.mockRejectedValue(new Error('ENOTFOUND'));
    expect(await isHostAllowed('nxdomain.invalid')).toBe(false);
  });

  it('fails closed on an empty resolution', async () => {
    lookup.mockResolvedValue([]);
    expect(await isHostAllowed('empty.example')).toBe(false);
  });

  it('rejects literal private IPs and blocked names without resolving', async () => {
    expect(await isHostAllowed('127.0.0.1')).toBe(false);
    expect(await isHostAllowed('10.0.0.1')).toBe(false);
    expect(await isHostAllowed('localhost')).toBe(false);
    expect(await isHostAllowed('metadata.google.internal')).toBe(false);
    expect(await isHostAllowed('foo.internal')).toBe(false);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('allows a public IP literal without resolving', async () => {
    expect(await isHostAllowed('93.184.216.34')).toBe(true);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('rejects empty / non-string input', async () => {
    expect(await isHostAllowed('')).toBe(false);
    expect(await isHostAllowed(null)).toBe(false);
  });
});

describe('validateExternalUrlAsync', () => {
  beforeEach(() => lookup.mockReset());

  it('rejects a URL whose host resolves to a private address', async () => {
    lookup.mockResolvedValue([{ address: '10.1.2.3', family: 4 }]);
    const r = await validateExternalUrlAsync('https://evil.example/hook');
    expect(r.valid).toBe(false);
  });

  it('accepts a URL whose host resolves public', async () => {
    lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    expect((await validateExternalUrlAsync('https://example.com/hook')).valid).toBe(true);
  });

  it('rejects a malformed URL', async () => {
    expect((await validateExternalUrlAsync('not a url')).valid).toBe(false);
  });
});
