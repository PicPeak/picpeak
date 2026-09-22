const http = require('http');
jest.mock('../../src/utils/frontendUrl', () => ({ getFrontendBaseUrl: async () => 'https://gallery.example.test' }));
const service = require('../../src/services/oidcService');

test('OIDC discovery and metadata-derived endpoints all enforce the outbound policy', async () => {
  let targetHits = 0;
  const target = http.createServer((_req, res) => { targetHits++; res.end('{}'); });
  await new Promise(resolve => target.listen(0, '127.0.0.1', resolve));
  const targetOrigin = `http://127.0.0.1:${target.address().port}`;
  let issuerOrigin;
  const issuer = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ issuer: issuerOrigin, authorization_endpoint: `${issuerOrigin}/authorize`,
      token_endpoint: `${targetOrigin}/token`, userinfo_endpoint: `${targetOrigin}/userinfo`, jwks_uri: `${targetOrigin}/jwks`,
      response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'] }));
  });
  await new Promise(resolve => issuer.listen(0, '127.0.0.1', resolve));
  issuerOrigin = `http://127.0.0.1:${issuer.address().port}`;
  const config = { issuerUrl: issuerOrigin, clientId: 'test-client', clientSecret: 'test-only' };
  const previous = process.env.INTEGRATION_PRIVATE_ORIGINS;
  try {
    delete process.env.INTEGRATION_PRIVATE_ORIGINS;
    service.invalidateDiscoveryCache();
    await expect(service.getClient(config)).rejects.toThrow(/not permitted/);
    process.env.INTEGRATION_PRIVATE_ORIGINS = issuerOrigin;
    const { client } = await service.getClient(config);
    await expect(client.userinfo('test-token')).rejects.toThrow(/not permitted/);
    await expect(client.grant({ grant_type: 'client_credentials' })).rejects.toThrow(/not permitted/);
    await expect(client.issuer.reloadJwksUri()).rejects.toThrow(/not permitted/);
    expect(targetHits).toBe(0);
  } finally {
    service.invalidateDiscoveryCache();
    if (previous === undefined) delete process.env.INTEGRATION_PRIVATE_ORIGINS;
    else process.env.INTEGRATION_PRIVATE_ORIGINS = previous;
    await new Promise(resolve => issuer.close(resolve));
    await new Promise(resolve => target.close(resolve));
  }
});
