const dns = require('dns');
const http = require('http');
const axios = require('axios');
const { validateExternalUrlAsync } = require('../../src/utils/networkValidation');
const { pinnedRequestOptions } = require('../../src/utils/pinnedRequest');
afterEach(() => jest.restoreAllMocks());
it('never performs a second DNS lookup that could reach a private listener', async () => {
  const received = jest.fn();
  const server = http.createServer((req, res) => { received(); res.end('private'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://rebind.example:${server.address().port}/hook`;
  // A real public unicast address: the preflight has to classify it as
  // reachable. TEST-NET-1 (192.0.2.1) no longer qualifies — the SSRF guard
  // refuses every IANA special-purpose range, documentation nets included,
  // the same way integrationHttp and s3EndpointPolicy always did. Nothing is
  // listening on this port there, so the pinned connect times out.
  const preflight = jest.spyOn(dns.promises, 'lookup').mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  const unsafeLookup = jest.spyOn(dns, 'lookup').mockImplementation((_host, opts, cb) => {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    cb(null, ...(opts.all ? [[{ address: '127.0.0.1', family: 4 }]] : ['127.0.0.1', 4]));
  });
  let options;
  try {
    const check = await validateExternalUrlAsync(url);
    options = pinnedRequestOptions(check);
    await expect(axios.post(url, 'private-data', { ...options, timeout: 200 })).rejects.toThrow();
    expect(preflight).toHaveBeenCalledTimes(1);
    expect(unsafeLookup).not.toHaveBeenCalled(); expect(received).not.toHaveBeenCalled();
  } finally {
    options?.httpAgent.destroy(); options?.httpsAgent.destroy();
    await new Promise(resolve => server.close(resolve));
  }
});
it('preserves the original Host and refuses redirects while using the pinned address', async () => {
  const hosts = [];
  const server = http.createServer((req, res) => {
    hosts.push(req.headers.host); res.writeHead(302, { Location: 'http://localhost/private' }); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const host = `pinned.example:${server.address().port}`;
  // Test the transport in isolation: production checks reject this private IP.
  const options = pinnedRequestOptions({ valid: true, hostname: 'pinned.example', addresses: [{ address: '127.0.0.1', family: 4 }] });
  try {
    const res = await axios.post(`http://${host}/hook`, 'body', { ...options, validateStatus: () => true });
    expect(res.status).toBe(302); expect(hosts).toEqual([host]); expect(options.proxy).toBe(false);
  } finally { options.httpAgent.destroy(); options.httpsAgent.destroy(); await new Promise(resolve => server.close(resolve)); }
});
it('fails closed for missing DNS results', () => {
  expect(() => pinnedRequestOptions({ valid: true })).toThrow('validated destination');
});

it('preserves TLS SNI and certificate hostname verification for a pinned connection', async () => {
  const fs = require('fs/promises');
  const path = require('path');
  const dir = await fs.mkdtemp(path.join(require('os').tmpdir(), 'picpeak-tls-pin-'));
  const key = path.join(dir, 'key.pem'), cert = path.join(dir, 'cert.pem');
  require('child_process').execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=pinned.example',
    '-addext', 'subjectAltName=DNS:pinned.example'], { stdio: 'ignore' });
  const certificate = await fs.readFile(cert);
  const seen = [];
  const server = require('https').createServer({ key: await fs.readFile(key), cert: certificate }, (req, res) => {
    seen.push({ host: req.headers.host, servername: req.socket.servername }); res.end('ok');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const makeOptions = hostname => {
    const options = pinnedRequestOptions({ valid: true, hostname, addresses: [{ address: '127.0.0.1', family: 4 }] });
    options.httpsAgent.options.ca = certificate;
    return options;
  };
  const allowed = makeOptions('pinned.example'), wrong = makeOptions('wrong.example');
  try {
    const host = `pinned.example:${server.address().port}`;
    expect((await axios.post(`https://${host}/hook`, 'data', { ...allowed, timeout: 2000 })).status).toBe(200);
    expect(seen).toEqual([{ host, servername: 'pinned.example' }]);
    await expect(axios.post(`https://wrong.example:${server.address().port}/hook`, 'data', { ...wrong, timeout: 2000 }))
      .rejects.toMatchObject({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
    expect(seen).toHaveLength(1);
  } finally {
    for (const options of [allowed, wrong]) { options.httpAgent.destroy(); options.httpsAgent.destroy(); }
    await new Promise(resolve => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  }
});
