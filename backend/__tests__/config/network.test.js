const {
  LEGACY_TRUST_PROXY,
  isTrustProxyUnset,
  parseTrustProxy,
  resolveListenHost,
} = require('../../src/config/network');
const express = require('express');
const request = require('supertest');

describe('network boundary configuration', () => {
  describe('parseTrustProxy', () => {
    test.each([undefined, null, '', '   '])(
      'keeps the legacy private-range trust when unset (%p)',
      (value) => {
        expect(isTrustProxyUnset(value)).toBe(true);
        expect(parseTrustProxy(value)).toBe(LEGACY_TRUST_PROXY);
        expect(LEGACY_TRUST_PROXY).toBe('loopback, linklocal, uniquelocal');
      }
    );

    test.each([false, 'false', ' FALSE '])(
      'does not trust forwarded headers for an explicit %p',
      (value) => {
        expect(isTrustProxyUnset(value)).toBe(false);
        expect(parseTrustProxy(value)).toBe(false);
      }
    );

    test('an explicit 0 trusts no hop', async () => {
      expect(parseTrustProxy('0')).toBe(0);
      const app = express();
      app.set('trust proxy', parseTrustProxy('0'));
      app.get('/', (req, res) => res.json({ ip: req.ip }));

      const response = await request(app).get('/').set('X-Forwarded-For', '203.0.113.9');

      expect(response.body.ip).not.toBe('203.0.113.9');
    });

    test.each([
      ['true', true],
      [' TRUE ', true],
      [true, true],
      ['2', 2],
      ['loopback', 'loopback'],
      ['127.0.0.1/8, 10.0.0.0/8', '127.0.0.1/8, 10.0.0.0/8'],
    ])('preserves an explicit Express trust boundary %p', (value, expected) => {
      expect(parseTrustProxy(value)).toEqual(expected);
    });
  });

  // Upgrade safety: an install that only pulls a new image has no TRUST_PROXY.
  // Its private-range proxy must keep yielding the real client, or every
  // guest shares one rate-limit bucket and req.secure is false behind TLS.
  test('unset still resolves the client and protocol behind a private-range proxy', async () => {
    const app = express();
    app.set('trust proxy', parseTrustProxy(undefined));
    app.get('/', (req, res) => res.json({ ip: req.ip, secure: req.secure }));

    const response = await request(app)
      .get('/')
      .set('X-Forwarded-For', '203.0.113.9, 172.20.0.1')
      .set('X-Forwarded-Proto', 'https');

    expect(response.body).toEqual({ ip: '203.0.113.9', secure: true });
  });

  test('an explicit false ignores a client-supplied forwarding chain', async () => {
    const app = express();
    app.set('trust proxy', parseTrustProxy('false'));
    app.get('/', (req, res) => res.json({ ip: req.ip, secure: req.secure }));

    const response = await request(app)
      .get('/')
      .set('X-Forwarded-For', '203.0.113.9')
      .set('X-Forwarded-Proto', 'https');

    expect(response.body.ip).not.toBe('203.0.113.9');
    expect(response.body.secure).toBe(false);
  });

  test('the Compose one-hop boundary stops at a private LAN client', async () => {
    const app = express();
    app.set('trust proxy', parseTrustProxy('1'));
    app.get('/', (req, res) => res.json({ ip: req.ip }));

    const response = await request(app)
      .get('/')
      .set('X-Forwarded-For', '203.0.113.9, 192.168.1.44');

    expect(response.body.ip).toBe('192.168.1.44');
  });

  test('the restricted two-hop TLS layout stops at the real client', async () => {
    const app = express();
    app.set('trust proxy', parseTrustProxy('2'));
    app.get('/', (req, res) => res.json({ ip: req.ip }));

    const response = await request(app)
      .get('/')
      .set('X-Forwarded-For', '203.0.113.9, 192.168.1.44, 172.20.0.1');

    expect(response.body.ip).toBe('192.168.1.44');
  });

  describe('resolveListenHost', () => {
    test.each([undefined, '', '   '])(
      'leaves the host to Node (all interfaces) when LISTEN_HOST is %p',
      (value) => expect(resolveListenHost({ value })).toBeUndefined()
    );

    test('an unset host binds the wildcard address', (done) => {
      const server = express().listen(0, resolveListenHost({ value: undefined }), () => {
        expect(['::', '0.0.0.0']).toContain(server.address().address);
        server.close(done);
      });
    });

    test('honors an explicit operator bind address', () => {
      expect(resolveListenHost({ value: ' 127.0.0.1 ' })).toBe('127.0.0.1');
      expect(resolveListenHost({ value: ' :: ' })).toBe('::');
    });
  });
});
