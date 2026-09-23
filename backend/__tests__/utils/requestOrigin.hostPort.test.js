/**
 * CSRF same-origin fallback compares Origin's host to req.headers.host.
 * Bundled nginx used to forward $host (port stripped), so a browser Origin
 * like http://nas:3000 never matched Host: nas and every mutation 403'd
 * (fork survey A2 / #1563). $http_host preserves the port; these cases pin
 * the comparison that change relies on.
 */
const { mutationOriginAllowed } = require('../../src/utils/requestOrigin');

jest.mock('../../src/utils/frontendUrl', () => ({
  getFrontendBaseUrlSync: () => 'http://localhost:3005',
}));

describe('mutationOriginAllowed — Host with non-default port', () => {
  it('allows Origin when its host:port matches the forwarded Host header', () => {
    const req = {
      protocol: 'http',
      headers: {
        origin: 'http://nas:3000',
        host: 'nas:3000',
      },
    };
    expect(mutationOriginAllowed(req)).toBe(true);
  });

  it('rejects Origin when Host lost the port (legacy $host behaviour)', () => {
    const req = {
      protocol: 'http',
      headers: {
        origin: 'http://nas:3000',
        host: 'nas',
      },
    };
    expect(mutationOriginAllowed(req)).toBe(false);
  });

  it('rejects a cross-site Origin even when Host carries a port', () => {
    const req = {
      protocol: 'http',
      headers: {
        origin: 'http://evil.example:3000',
        host: 'nas:3000',
      },
    };
    expect(mutationOriginAllowed(req)).toBe(false);
  });

  it('still trusts sec-fetch-site: same-origin without Origin', () => {
    const req = {
      protocol: 'http',
      headers: {
        'sec-fetch-site': 'same-origin',
        host: 'nas:3000',
      },
    };
    expect(mutationOriginAllowed(req)).toBe(true);
  });

  it('allows non-browser clients with no Origin and no Fetch Metadata', () => {
    const req = {
      protocol: 'http',
      headers: { host: 'nas:3000' },
    };
    expect(mutationOriginAllowed(req)).toBe(true);
  });
});
