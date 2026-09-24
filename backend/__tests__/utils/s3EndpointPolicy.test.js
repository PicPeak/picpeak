/**
 * Backup S3 endpoint policy (issue 1641): private endpoints only with an
 * exact-origin approval, link-local/metadata never, and every connection
 * re-validated so DNS rebinding cannot reach an internal address.
 */
const http = require('http');
const dns = require('dns');

const policy = require('../../src/utils/s3EndpointPolicy');
const S3StorageAdapter = require('../../src/services/storage/s3Storage');

const originalEnv = process.env.NODE_ENV;

afterEach(() => {
  jest.restoreAllMocks();
  process.env.NODE_ENV = originalEnv;
});

const resolveTo = (...answers) => jest.spyOn(dns.promises, 'lookup')
  .mockImplementation(async () => answers.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })));

describe('classifyAddress', () => {
  it.each([
    ['8.8.8.8', 'public'],
    ['2001:4860:4860::8888', 'public'],
    ['10.0.0.5', 'approvable'],
    ['192.168.1.10', 'approvable'],
    ['172.20.0.3', 'approvable'],
    ['127.0.0.1', 'approvable'],
    ['fd00::1', 'approvable'],
    ['169.254.169.254', 'forbidden'],
    ['fd00:ec2::254', 'forbidden'],
    ['fd00:ec2:0:0:0:0:0:254', 'forbidden'],
    ['100.100.100.200', 'forbidden'],
    ['::ffff:169.254.169.254', 'forbidden'],
    ['fe80::1', 'forbidden'],
    ['100.64.0.1', 'forbidden'],
    ['0.0.0.0', 'forbidden'],
    ['224.0.0.1', 'forbidden'],
    ['not-an-ip', 'forbidden'],
  ])('%s is %s', (address, expected) => {
    expect(policy.classifyAddress(address)).toBe(expected);
  });
});

describe('endpointOrigin', () => {
  it('adds the scheme from sslEnabled and keeps the port', () => {
    expect(policy.endpointOrigin('minio:9000')).toBe('https://minio:9000');
    expect(policy.endpointOrigin('minio:9000', false)).toBe('http://minio:9000');
    expect(policy.endpointOrigin('http://10.0.0.5:9000/')).toBe('http://10.0.0.5:9000');
  });

  it('refuses embedded credentials', () => {
    expect(policy.endpointOrigin('http://user:pass@10.0.0.5:9000')).toBeNull();
  });

  it('approves only the exact origin', () => {
    expect(policy.isPrivateEndpointApproved('http://10.0.0.5:9000', true, 'http://10.0.0.5:9000')).toBe(true);
    expect(policy.isPrivateEndpointApproved('http://10.0.0.5:9001', true, 'http://10.0.0.5:9000')).toBe(false);
    expect(policy.isPrivateEndpointApproved('https://10.0.0.5:9000', true, 'http://10.0.0.5:9000')).toBe(false);
    expect(policy.isPrivateEndpointApproved('http://10.0.0.5:9000', true, '')).toBe(false);
  });
});

describe('assertS3EndpointAllowed (production)', () => {
  beforeEach(() => { process.env.NODE_ENV = 'production'; });

  it('denies a private endpoint by default, with a stable code and the origin', async () => {
    resolveTo('10.0.0.5');
    await expect(policy.assertS3EndpointAllowed('http://rustfs.lan:9000')).rejects.toMatchObject({
      code: 'S3_PRIVATE_ENDPOINT', severity: 'warning', origin: 'http://rustfs.lan:9000',
    });
  });

  it('allows the private endpoint once approved', async () => {
    resolveTo('10.0.0.5');
    await expect(policy.assertS3EndpointAllowed('http://rustfs.lan:9000', { allowPrivate: true })).resolves.toBeUndefined();
  });

  it('never allows link-local or metadata destinations, approved or not', async () => {
    resolveTo('169.254.169.254');
    await expect(policy.assertS3EndpointAllowed('http://sneaky.example', { allowPrivate: true }))
      .rejects.toMatchObject({ code: 'S3_ENDPOINT_FORBIDDEN' });
    await expect(policy.assertS3EndpointAllowed('http://metadata.google.internal', { allowPrivate: true }))
      .rejects.toMatchObject({ code: 'S3_ENDPOINT_FORBIDDEN' });
    await expect(policy.assertS3EndpointAllowed('http://[fe80::1]:9000', { allowPrivate: true }))
      .rejects.toMatchObject({ code: 'S3_ENDPOINT_FORBIDDEN' });
    // AWS's IPv6 metadata endpoint sits in the approvable unique-local range.
    await expect(policy.assertS3EndpointAllowed('http://[fd00:ec2::254]', { allowPrivate: true }))
      .rejects.toMatchObject({ code: 'S3_ENDPOINT_FORBIDDEN' });
  });

  it('lets one forbidden answer among several forbid the endpoint', async () => {
    resolveTo('10.0.0.5', '169.254.169.254');
    await expect(policy.assertS3EndpointAllowed('http://mixed.example', { allowPrivate: true }))
      .rejects.toMatchObject({ code: 'S3_ENDPOINT_FORBIDDEN' });
  });

  it('still treats internal names as private when they resolve publicly', async () => {
    resolveTo('8.8.8.8');
    await expect(policy.assertS3EndpointAllowed('https://storage.internal'))
      .rejects.toMatchObject({ code: 'S3_PRIVATE_ENDPOINT' });
  });

  it('allows a public endpoint without approval', async () => {
    resolveTo('52.216.0.1');
    await expect(policy.assertS3EndpointAllowed('https://s3.example.com')).resolves.toBeUndefined();
  });

  it('is a no-op outside production', async () => {
    process.env.NODE_ENV = 'test';
    await expect(policy.assertS3EndpointAllowed('http://127.0.0.1:9000')).resolves.toBeUndefined();
  });
});

describe('connection-time validation (DNS rebinding)', () => {
  const lookupThrough = (agent, host) => new Promise((resolve) => {
    agent.options.lookup(host, {}, (error, address) => resolve({ error, address }));
  });

  it('rejects an answer that turns private after the preflight', async () => {
    const lookup = jest.spyOn(dns.promises, 'lookup')
      .mockResolvedValueOnce([{ address: '52.216.0.1', family: 4 }])
      .mockResolvedValue([{ address: '10.0.0.5', family: 4 }]);
    process.env.NODE_ENV = 'production';

    await expect(policy.assertS3EndpointAllowed('https://rebind.example')).resolves.toBeUndefined();
    const { httpsAgent } = policy.s3EndpointAgents('https://rebind.example');
    const { error, address } = await lookupThrough(httpsAgent, 'rebind.example');

    expect(address).toBeUndefined();
    expect(error).toMatchObject({ code: 'S3_PRIVATE_ENDPOINT' });
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('rejects a rebind to metadata even for an approved private endpoint', async () => {
    resolveTo('169.254.169.254');
    const { httpAgent } = policy.s3EndpointAgents('http://rustfs.lan:9000', { sslEnabled: false, allowPrivate: true });
    const { error } = await lookupThrough(httpAgent, 'rustfs.lan');
    expect(error).toMatchObject({ code: 'S3_ENDPOINT_FORBIDDEN' });
  });

  it('refuses a lookup for a host other than the endpoint', async () => {
    resolveTo('10.0.0.5');
    const { httpAgent } = policy.s3EndpointAgents('http://rustfs.lan:9000', { allowPrivate: true });
    const { error } = await lookupThrough(httpAgent, 'elsewhere.lan');
    expect(error).toMatchObject({ code: 'S3_ENDPOINT_FORBIDDEN' });
  });

  describe('through the S3 client, against a real socket', () => {
    let server; let port; let requests;

    beforeAll(async () => {
      requests = 0;
      server = http.createServer((req, res) => { requests += 1; res.statusCode = 200; res.end(); });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      ({ port } = server.address());
    });
    afterAll(() => new Promise((resolve) => server.close(resolve)));
    beforeEach(() => { requests = 0; process.env.NODE_ENV = 'production'; });

    const adapter = (allowPrivateEndpoint) => new S3StorageAdapter({
      endpoint: `http://bucket-host.test:${port}`,
      bucket: 'backups',
      accessKeyId: 'key',
      secretAccessKey: 'secret',
      allowPrivateEndpoint,
      maxRetries: 1,
    });

    it('never opens a connection when the name rebinds to a private address', async () => {
      // Preflight sees a public answer, the connection sees loopback.
      jest.spyOn(dns.promises, 'lookup')
        .mockResolvedValueOnce([{ address: '52.216.0.1', family: 4 }])
        .mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);

      await expect(adapter(false).testConnection()).rejects.toThrow(/S3_PRIVATE_ENDPOINT/);
      expect(requests).toBe(0);
    });

    it('connects when that private endpoint is approved', async () => {
      resolveTo('127.0.0.1');
      await expect(adapter(true).testConnection()).resolves.toBe(true);
      expect(requests).toBeGreaterThan(0);
    });
  });
});

describe('S3StorageAdapter constructor (production)', () => {
  beforeEach(() => { process.env.NODE_ENV = 'production'; });

  it('refuses a private IP literal unless approved, and a link-local one always', () => {
    const make = (endpoint, allowPrivateEndpoint) => () => new S3StorageAdapter({
      endpoint, bucket: 'b', accessKeyId: 'k', secretAccessKey: 's', allowPrivateEndpoint,
    });
    expect(make('http://10.0.0.5:9000', false)).toThrow(/S3_PRIVATE_ENDPOINT/);
    expect(make('http://10.0.0.5:9000', true)).not.toThrow();
    expect(make('http://169.254.169.254', true)).toThrow(/S3_ENDPOINT_FORBIDDEN/);
  });
});
