/**
 * Adapter-style tests for the Umami metrics client (#663 Phase 1, replaces
 * the old `umamiClient.test.js` from #662 — same contract, new shape).
 *
 * Pins the same 10 cases that protected the original implementation: missing
 * config / URL shape / encoding / payload normalisation / `laptop` mapping /
 * unknown-bucket drop / empty / non-2xx / invalid JSON / network error.
 */

const { buildAdapter } = require('../../src/services/trackers/umamiAdapter');

const ORIGINAL_FETCH = global.fetch;

afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
});

function mockJson(body, { status = 200 } = {}) {
  global.fetch = jest.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }));
}

const valid = { baseUrl: 'https://u.example.com', websiteId: 'site-123', apiKey: 'secret' };

describe('umamiAdapter.fetchDeviceBreakdown (#663)', () => {
  test('returns null when config is incomplete (back-compat path)', async () => {
    const a = buildAdapter({});
    expect(await a.fetchDeviceBreakdown({ startMs: 0, endMs: 0 })).toBeNull();
    const b = buildAdapter({ baseUrl: 'https://u' });
    expect(await b.fetchDeviceBreakdown({ startMs: 0, endMs: 0 })).toBeNull();
    expect(global.fetch).toBe(ORIGINAL_FETCH);
  });

  test('builds the expected URL + sends `x-umami-api-key` header', async () => {
    mockJson([{ x: 'desktop', y: 10 }]);
    const a = buildAdapter({ ...valid, baseUrl: 'https://u.example.com/' });
    await a.fetchDeviceBreakdown({ startMs: 1700000000000, endMs: 1700003600000 });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = global.fetch.mock.calls[0];
    expect(calledUrl).toBe(
      'https://u.example.com/api/websites/site-123/metrics?type=device&startAt=1700000000000&endAt=1700003600000',
    );
    expect(init.headers['x-umami-api-key']).toBe('secret');
    expect(init.method).toBe('GET');
  });

  test('URL-encodes the websiteId for reserved chars', async () => {
    mockJson([{ x: 'desktop', y: 1 }]);
    const a = buildAdapter({ baseUrl: 'https://u', websiteId: 'a/b?c', apiKey: 'k' });
    await a.fetchDeviceBreakdown({ startMs: 0, endMs: 0 });
    const [calledUrl] = global.fetch.mock.calls[0];
    expect(calledUrl).toContain('/api/websites/a%2Fb%3Fc/metrics');
  });

  test('normalises { x, y } payload into integer percentages', async () => {
    mockJson([
      { x: 'desktop', y: 60 },
      { x: 'mobile', y: 30 },
      { x: 'tablet', y: 10 },
    ]);
    const a = buildAdapter(valid);
    const out = await a.fetchDeviceBreakdown({ startMs: 0, endMs: 0 });
    expect(out).toEqual({ desktop: 60, mobile: 30, tablet: 10 });
  });

  test('maps `laptop` into `desktop` (matches our 3-bucket UI)', async () => {
    mockJson([
      { x: 'desktop', y: 50 },
      { x: 'laptop', y: 20 },
      { x: 'mobile', y: 30 },
    ]);
    const out = await buildAdapter(valid).fetchDeviceBreakdown({ startMs: 0, endMs: 0 });
    expect(out).toEqual({ desktop: 70, mobile: 30, tablet: 0 });
  });

  test('drops unknown buckets (no silent miscategorisation)', async () => {
    mockJson([
      { x: 'desktop', y: 80 },
      { x: 'mobile', y: 20 },
      { x: 'unknown-future-bucket', y: 100 },
    ]);
    const out = await buildAdapter(valid).fetchDeviceBreakdown({ startMs: 0, endMs: 0 });
    expect(out).toEqual({ desktop: 80, mobile: 20, tablet: 0 });
  });

  test('returns null on empty payload', async () => {
    mockJson([]);
    expect(await buildAdapter(valid).fetchDeviceBreakdown({ startMs: 0, endMs: 0 })).toBeNull();
  });

  test('returns null on non-2xx', async () => {
    mockJson({ error: 'unauthorized' }, { status: 401 });
    expect(await buildAdapter(valid).fetchDeviceBreakdown({ startMs: 0, endMs: 0 })).toBeNull();
  });

  test('returns null on invalid JSON', async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError('not json'); },
    }));
    expect(await buildAdapter(valid).fetchDeviceBreakdown({ startMs: 0, endMs: 0 })).toBeNull();
  });

  test('returns null on network error', async () => {
    global.fetch = jest.fn(async () => { throw new Error('ECONNREFUSED'); });
    expect(await buildAdapter(valid).fetchDeviceBreakdown({ startMs: 0, endMs: 0 })).toBeNull();
  });
});
