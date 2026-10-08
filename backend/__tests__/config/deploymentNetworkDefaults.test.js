const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../../..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

describe('shipped deployment network boundaries', () => {
  test.each(['docker-compose.yml', 'docker-compose.production.yml'])(
    '%s keeps the frontend reachable on upgrade and the raw backend on loopback',
    (file) => {
      const compose = read(file);
      expect(compose).toContain('TRUST_PROXY=${TRUST_PROXY:-}');
      expect(compose).toContain('COOKIE_SECURE=${COOKIE_SECURE:-auto}');
      expect(compose).toContain('${PICPEAK_BACKEND_BIND_ADDRESS:-127.0.0.1}:${BACKEND_PORT:-3001}:3000');
      expect(compose).toContain('${PICPEAK_BIND_ADDRESS:-0.0.0.0}:${FRONTEND_PORT:-3000}:80');
    }
  );

  // An image-only upgrade keeps the old compose file, whose healthcheck
  // probes http://localhost:3000 (::1 first on Alpine). Pinning the listener
  // to IPv4 in the image or the compose file turns that container unhealthy.
  test.each(['backend/Dockerfile', 'Dockerfile.aio', 'docker-compose.yml', 'docker-compose.production.yml'])(
    '%s leaves the listen host at the all-interfaces default',
    (file) => expect(read(file)).not.toContain('LISTEN_HOST')
  );

  test('the server warns once at boot when TRUST_PROXY is left unset in production', () => {
    const server = read('backend/server.js');
    expect(server).toContain('&& isTrustProxyUnset()) {');
    expect(server).toContain('TRUST_PROXY is not set');
    expect(server.match(/TRUST_PROXY is not set/g)).toHaveLength(1);
  });

  test.each(['backend/Dockerfile', 'docker-compose.production.yml', '.github/workflows/install-smoke.yml'])(
    '%s probes the IPv4 listener without relying on localhost resolving to IPv4',
    (file) => {
      const source = read(file);
      expect(source).toContain('http://127.0.0.1:3000/health');
      expect(source).not.toContain('http://localhost:3000/health');
    }
  );

  test('the installer closes the plaintext side door in TLS modes', () => {
    const installer = read('scripts/picpeak-setup.sh');
    expect(installer).toContain('PICPEAK_BIND_ADDRESS=$public_bind_address');
    expect(installer).toContain('LISTEN_HOST=$listen_host');
    expect(installer).toContain('TRUST_PROXY=$trust_proxy');
    expect(installer).toContain('COOKIE_SECURE=$cookie_secure');
    expect(installer).toContain('ENABLE_HSTS=$enable_hsts');
    expect(installer).toContain('public_bind_address="127.0.0.1"');
    expect(installer).toContain('trust_proxy="loopback"');
    expect(installer).toContain('--allow-insecure-http override');
  });
});
