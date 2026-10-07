const { parseTrustProxy, resolveListenHost } = require('../../src/config/network');
const express = require('express');
const request = require('supertest');

describe('network boundary configuration', () => {
  describe('parseTrustProxy', () => {
    test.each([undefined, null, '', '   ', false, 'false', ' FALSE '])(
      'does not trust forwarded headers for %p',
      (value) => expect(parseTrustProxy(value)).toBe(false)
    );

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

  test('the default ignores a client-supplied forwarding chain', async () => {
    const app = express();
    app.set('trust proxy', parseTrustProxy(undefined));
    app.get('/', (req, res) => res.json({ ip: req.ip }));

    const response = await request(app)
      .get('/')
      .set('X-Forwarded-For', '203.0.113.9');

    expect(response.body.ip).not.toBe('203.0.113.9');
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
    test('binds native production to loopback by default', () => {
      expect(resolveListenHost({ nodeEnv: 'production', value: undefined })).toBe('127.0.0.1');
    });

    test.each(['development', 'test', undefined])(
      'retains all-interface binding in %p',
      (nodeEnv) => expect(resolveListenHost({ nodeEnv, value: undefined })).toBe('0.0.0.0')
    );

    test('honors an explicit container or operator bind address', () => {
      expect(resolveListenHost({ nodeEnv: 'production', value: ' :: ' })).toBe('::');
    });
  });
});
