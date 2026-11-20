/**
 * Event code lookup limiter under concurrent valid lookups (issue 2495).
 *
 * Only misses count against an address. Valid lookups arriving together from
 * one venue address are counted while in flight, so some of them may get a
 * 429; those 429s must not stay behind as misses and block the address.
 */
jest.mock('../../src/services/eventAccessCode', () => ({ resolveAccessCode: jest.fn() }));

const express = require('express');
const request = require('supertest');
const { resolveAccessCode } = require('../../src/services/eventAccessCode');
const router = require('../../src/routes/publicEventCode');

const app = express();
app.set('trust proxy', true);
app.use('/api/public/event-code', router);

const lookup = (code) => request(app).get(`/api/public/event-code/${code}`).set('X-Forwarded-For', '203.0.113.7');

describe('event code limiter with concurrent valid lookups', () => {
  it('does not keep the 429s of overlapping valid lookups as misses', async () => {
    const pending = [];
    resolveAccessCode.mockImplementation(() => new Promise((resolve) => pending.push(resolve)));

    const burst = Array.from({ length: 40 }, () => lookup('K7M4QX').then((res) => res.status));
    // 20 lookups are in the resolver; the other 20 are over the limit while
    // those are still in flight.
    await new Promise((resolve) => {
      const check = () => (pending.length >= 20 ? resolve() : setTimeout(check, 5));
      check();
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    pending.forEach((resolve) => resolve('/gallery/wedding/token'));
    const statuses = await Promise.all(burst);
    expect(statuses.filter((s) => s === 200)).toHaveLength(20);
    expect(statuses.filter((s) => s === 429)).toHaveLength(20);

    resolveAccessCode.mockResolvedValue('/gallery/wedding/token');
    expect((await lookup('K7M4QX')).status).toBe(200);
  });

  it('still blocks an address after twenty misses, valid codes included', async () => {
    resolveAccessCode.mockResolvedValue(null);
    const ip = '198.51.100.9';
    for (let i = 0; i < 20; i += 1) {
      expect((await request(app).get('/api/public/event-code/AAAAAA').set('X-Forwarded-For', ip)).status).toBe(404);
    }
    resolveAccessCode.mockResolvedValue('/gallery/wedding/token');
    for (let i = 0; i < 3; i += 1) {
      expect((await request(app).get('/api/public/event-code/K7M4QX').set('X-Forwarded-For', ip)).status).toBe(429);
    }
  });
});
