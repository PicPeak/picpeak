/**
 * The app-wide API and auth limiters key on rateLimitKey (an IPv6 /64 is one
 * client), but the public routes' own limiters and the in-memory counters kept
 * keying on the raw req.ip. express-rate-limit 6's default keyGenerator is
 * req.ip too, so a limiter without an explicit keyGenerator has the same
 * IPv6 bypass: a fresh address per request, a fresh budget per request.
 *
 * The sweep pins every express-rate-limit instance in src; the behavioural
 * tests drive the hand-rolled counters.
 */
const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');

jest.mock('../../src/database/db', () => ({ db: jest.fn() }));
jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn()
}));

const { db } = require('../../src/database/db');
const { strictRateLimit, dispose } = require('../../src/middleware/feedbackRateLimit');
const { loadActionToken, _internal } = require('../../src/utils/publicTokenGuards');

const SRC = path.join(__dirname, '..', '..', 'src');

function jsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return jsFiles(full);
    return e.name.endsWith('.js') ? [full] : [];
  });
}

// The argument text of every `rateLimit(` call, by paren matching.
function rateLimitCalls(source) {
  const calls = [];
  const re = /\brateLimit\(/g;
  let m;
  while ((m = re.exec(source))) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < source.length && depth > 0; i++) {
      if (source[i] === '(') depth++;
      else if (source[i] === ')') depth--;
    }
    calls.push(source.slice(m.index + m[0].length, i - 1));
  }
  return calls;
}

afterAll(() => dispose());

describe('every express-rate-limit instance picks its key explicitly', () => {
  const files = jsFiles(SRC).filter((f) => /require\(['"]express-rate-limit['"]\)/.test(fs.readFileSync(f, 'utf8')));

  it('finds the limiters it is meant to sweep', () => {
    expect(files.length).toBeGreaterThanOrEqual(10);
  });

  it.each(files.map((f) => [path.relative(SRC, f), f]))('%s', (_rel, file) => {
    const calls = rateLimitCalls(fs.readFileSync(file, 'utf8'))
      .filter((args) => args.trim().startsWith('{'));
    for (const args of calls) {
      // No keyGenerator means express-rate-limit's default: the raw req.ip.
      expect(args).toMatch(/keyGenerator:/);
      const keyGen = args.slice(args.indexOf('keyGenerator:')).split('\n')[0];
      expect(keyGen).not.toMatch(/req\.ip\b/);
    }
  });
});

describe('strictRateLimit (feedbackRateLimit.js)', () => {
  function buildApp() {
    const app = express();
    app.set('trust proxy', true);
    app.use(strictRateLimit({ max: 3 }));
    app.get('/x', (req, res) => res.sendStatus(200));
    return app;
  }

  it('counts an IPv6 /64 as one client', async () => {
    const app = buildApp();
    for (let i = 1; i <= 3; i++) {
      expect((await request(app).get('/x').set('X-Forwarded-For', `2001:db8:1:2::${i}`)).status).toBe(200);
    }
    expect((await request(app).get('/x').set('X-Forwarded-For', '2001:db8:1:2::ff')).status).toBe(429);
    expect((await request(app).get('/x').set('X-Forwarded-For', '2001:db8:1:3::1')).status).toBe(200);
  });

  it('still counts IPv4 one address at a time', async () => {
    const app = buildApp();
    for (let i = 0; i < 3; i++) await request(app).get('/x').set('X-Forwarded-For', '203.0.113.7');
    expect((await request(app).get('/x').set('X-Forwarded-For', '203.0.113.7')).status).toBe(429);
    expect((await request(app).get('/x').set('X-Forwarded-For', '203.0.113.8')).status).toBe(200);
  });
});

describe('loadActionToken bad-token lockout (publicTokenGuards.js)', () => {
  beforeEach(() => {
    _internal.badAttempts.clear();
    db.mockImplementation(() => ({ where: () => ({ first: () => Promise.resolve(undefined) }) }));
  });

  const attempt = async (ip) => {
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
    await loadActionToken({ ip }, res, { tableName: 'quote_action_tokens', token: 'x'.repeat(64) });
    return res.status.mock.calls[0][0];
  };

  it('locks the whole /64 after 20 unknown tokens from rotating addresses', async () => {
    for (let i = 1; i <= 20; i++) {
      expect(await attempt(`2001:db8:1:2::${i.toString(16)}`)).toBe(404);
    }
    expect(await attempt('2001:db8:1:2:dead::1')).toBe(429);
    expect(await attempt('2001:db8:1:3::1')).toBe(404);
  });

  it('still locks IPv4 one address at a time', async () => {
    for (let i = 0; i < 20; i++) await attempt('203.0.113.7');
    expect(await attempt('203.0.113.7')).toBe(429);
    expect(await attempt('203.0.113.8')).toBe(404);
  });
});

describe('guest registration and recovery counters (galleryGuests.js)', () => {
  it('key every check on rateLimitKey, not the raw req.ip', () => {
    const source = fs.readFileSync(path.join(SRC, 'routes', 'galleryGuests.js'), 'utf8');
    const checks = [...source.matchAll(/const ip = (.+);\n\s+if \(!check(?:Registration|Recovery)Rate\(ip\)\)/g)];
    expect(checks).toHaveLength(3);
    for (const [, expr] of checks) expect(expr).toBe('rateLimitKey(req) || \'unknown\'');
  });
});
