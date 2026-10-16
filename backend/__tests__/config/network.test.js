const {
  LEGACY_TRUST_PROXY,
  createProxyChainWarning,
  isTrustProxyUnset,
  parseTrustProxy,
  resolveListenHost,
} = require('../../src/config/network');
const express = require('express');
const request = require('supertest');

describe('rate-limit client IP behind the bundled nginx hop', () => {
  // nginx does `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for`,
  // which appends the address it saw to whatever the client sent.
  const NGINX_PEER_SEEN = '192.168.1.20';
  const ipFor = async (trustProxy, spoofed) => {
    const app = express();
    app.set('trust proxy', trustProxy);
    app.get('/ip', (req, res) => res.json({ ip: req.ip }));
    const res = await request(app)
      .get('/ip')
      .set('X-Forwarded-For', `${spoofed}, ${NGINX_PEER_SEEN}`);
    return res.body.ip;
  };

  test('with the Compose default of one hop a spoofed header does not change the key', async () => {
    const keys = new Set();
    for (const spoofed of ['1.1.1.1', '2.2.2.2', '3.3.3.3']) {
      keys.add(await ipFor(parseTrustProxy('1'), spoofed));
    }
    expect([...keys]).toEqual([NGINX_PEER_SEEN]);
  });

  test('the legacy private-range trust lets a private-range client choose its key', async () => {
    expect(await ipFor(parseTrustProxy(undefined), '1.1.1.1')).toBe('1.1.1.1');
    expect(await ipFor(parseTrustProxy(undefined), '2.2.2.2')).toBe('2.2.2.2');
  });
});

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

describe('createProxyChainWarning', () => {
  const run = async (trustProxy, headers) => {
    const logger = { warn: jest.fn() };
    const app = express();
    app.set('trust proxy', trustProxy);
    app.use(createProxyChainWarning({ trustProxy: app.get('trust proxy'), logger }));
    app.get('/', (req, res) => res.json({ ip: req.ip }));
    const bodies = [];
    for (const header of headers) {
      const req = request(app).get('/');
      if (header !== undefined) req.set('X-Forwarded-For', header);
      bodies.push((await req).body);
    }
    return { logger, bodies };
  };

  test('warns once when a private proxy forwards to nginx under one trusted hop', async () => {
    const { logger, bodies } = await run(parseTrustProxy('1'), [
      '203.0.113.9, 172.20.0.5',
      '198.51.100.7, 172.20.0.5',
      '203.0.113.10, 172.20.0.5',
    ]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [message] = logger.warn.mock.calls[0];
    expect(message).toContain('TRUST_PROXY=2');
    expect(message).toContain('172.20.0.5');
    expect(message).not.toContain('203.0.113.9');
    // No behaviour change: req.ip is still the hop nginx saw.
    expect(bodies.map((b) => b.ip)).toEqual(['172.20.0.5', '172.20.0.5', '172.20.0.5']);
  });

  test('stays quiet for a public client reaching nginx directly', async () => {
    const { logger } = await run(parseTrustProxy('1'), [
      '203.0.113.9',
      '1.1.1.1, 203.0.113.9',
      undefined,
    ]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test('stays quiet for a LAN client reaching nginx directly', async () => {
    const { logger } = await run(parseTrustProxy('1'), ['192.168.1.20']);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test('a LAN client forging the header gets a conditional message, not a bare TRUST_PROXY=2', async () => {
    const { logger, bodies } = await run(parseTrustProxy('1'), ['1.1.1.1, 192.168.1.20']);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [message] = logger.warn.mock.calls[0];
    expect(message).toMatch(/If another reverse proxy forwards to nginx/);
    expect(message).toMatch(/Leave TRUST_PROXY=1 if clients can reach nginx directly/);
    expect(message).not.toContain('1.1.1.1');
    expect(bodies[0].ip).toBe('192.168.1.20');
  });

  test('logs the private hop canonically, without an IPv6 zone from the header', async () => {
    const { logger } = await run(parseTrustProxy('1'), ['203.0.113.9, fe80::1%zoneSecret']);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [message] = logger.warn.mock.calls[0];
    expect(message).toContain('from fe80::1 ');
    expect(message).not.toContain('zoneSecret');
  });

  test.each([['2'], ['false'], [undefined], ['loopback']])(
    'stays quiet when TRUST_PROXY is %p',
    async (value) => {
      const { logger } = await run(parseTrustProxy(value), ['203.0.113.9, 172.20.0.5']);
      expect(logger.warn).not.toHaveBeenCalled();
    }
  );
});
