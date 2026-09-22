const http = require('http');
const dns = require('dns').promises;
const { integrationFetch, integrationRequestOptions } = require('../../src/utils/integrationHttp');
const originalOrigins = process.env.INTEGRATION_PRIVATE_ORIGINS;
afterEach(() => {
  jest.restoreAllMocks();
  if (originalOrigins === undefined) delete process.env.INTEGRATION_PRIVATE_ORIGINS;
  else process.env.INTEGRATION_PRIVATE_ORIGINS = originalOrigins;
});
beforeEach(() => { delete process.env.INTEGRATION_PRIVATE_ORIGINS; });
const lookup = (options, hostname) => new Promise((resolve, reject) => {
  options.lookup(hostname, { all: true }, (error, records) => error ? reject(error) : resolve(records));
});

test.each(['http://127.0.0.1', 'http://2130706433', 'http://[::1]', 'http://[::ffff:7f00:1]',
  'http://10.1.2.3', 'http://169.254.169.254', 'http://100.100.100.200', 'http://[64:ff9b::a9fe:a9fe]'])
('blocks private and special destinations by default: %s', url => {
  expect(() => integrationRequestOptions(url)).toThrow();
});
test.each(['http://169.254.169.254', 'http://metadata.google.internal', 'http://0.0.0.0', 'http://[fe80::1]'])
('never exempts metadata/unsafe targets: %s', url => {
  process.env.INTEGRATION_PRIVATE_ORIGINS = url;
  expect(() => integrationRequestOptions(url)).toThrow();
});
test('private exceptions are exact origins with no wildcard, credential, or port expansion', () => {
  process.env.INTEGRATION_PRIVATE_ORIGINS = 'http://127.0.0.1:8123';
  expect(() => integrationRequestOptions('http://127.0.0.1:8123/metrics')).not.toThrow();
  expect(() => integrationRequestOptions('http://127.0.0.1:8124/metrics')).toThrow();
  expect(() => integrationRequestOptions('https://127.0.0.1:8123/metrics')).toThrow();
  expect(() => integrationRequestOptions('http://user:pass@127.0.0.1:8123')).toThrow();
});
test('validates every DNS answer at connection time and rejects rebinding/mixed answers', async () => {
  const resolve = jest.spyOn(dns, 'lookup')
    .mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }])
    .mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }])
    .mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }]);
  const options = integrationRequestOptions('https://tracker.example');
  expect(await lookup(options, 'tracker.example')).toEqual([{ address: '8.8.8.8', family: 4 }]);
  await expect(lookup(options, 'tracker.example')).rejects.toThrow(/not permitted/);
  await expect(lookup(options, 'tracker.example')).rejects.toThrow(/not permitted/);
  expect(resolve).toHaveBeenCalledTimes(3);
  expect(options.agent).toBe(false);
});

test('real tracker requests reach an approved private origin, never follow redirects, and bound bodies', async () => {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push({ url: req.url, host: req.headers.host });
    if (req.url === '/redirect') { res.writeHead(302, { Location: '/trap' }); res.end(); }
    else if (req.url === '/large') res.end('x'.repeat(1024 * 1024 + 1));
    else res.end(JSON.stringify({ ok: true }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://tracker.internal:${server.address().port}`;
  process.env.INTEGRATION_PRIVATE_ORIGINS = origin;
  jest.spyOn(dns, 'lookup').mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
  try {
    expect(await (await integrationFetch(`${origin}/metrics`)).json()).toEqual({ ok: true });
    expect(hits[0].host).toBe(`tracker.internal:${server.address().port}`);
    await expect(integrationFetch(`${origin}/redirect`)).rejects.toThrow(/redirects/);
    expect(hits.some(hit => hit.url === '/trap')).toBe(false);
    await expect(integrationFetch(`${origin}/large`)).rejects.toThrow(/1 MiB/);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
