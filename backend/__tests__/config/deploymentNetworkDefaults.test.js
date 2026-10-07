const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../../..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

describe('shipped deployment network boundaries', () => {
  test.each(['docker-compose.yml', 'docker-compose.production.yml'])(
    '%s publishes only the public proxy on a configurable loopback default',
    (file) => {
      const compose = read(file);
      expect(compose).toContain('LISTEN_HOST=0.0.0.0');
      expect(compose).toContain('TRUST_PROXY=${TRUST_PROXY:-1}');
      expect(compose).toContain('127.0.0.1:${BACKEND_PORT:-3001}:3000');
      expect(compose).toContain('${PICPEAK_BIND_ADDRESS:-127.0.0.1}:${FRONTEND_PORT:-3000}:80');
    }
  );

  test.each(['backend/Dockerfile', 'Dockerfile.aio'])(
    '%s explicitly opts the container into its network interface',
    (file) => expect(read(file)).toContain('LISTEN_HOST=0.0.0.0')
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
