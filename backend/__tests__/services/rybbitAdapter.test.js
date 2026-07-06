/**
 * Tests for the Rybbit metrics-API adapter (#663 Phase 1). Mirrors the
 * `umamiAdapter` test contract: missing config / URL shape / encoding /
 * normalisation / unknown-bucket drop / failure modes.
 *
 * Rybbit's documented endpoint is `/api/site/{websiteId}/breakdown` with
 * `dimension=device`; we accept both bare-array and `{ data: [...] }`
 * envelopes since their docs hint at minor v0 → v1 shape variation.
 */

const { buildAdapter } = require('../../src/services/trackers/rybbitAdapter');

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

const valid = { baseUrl: 'https://r.example.com', websiteId: 'rsite-789', apiKey: 'rkey' };

describe('rybbitAdapter.fetchDeviceBreakdown (#663)', () => {
  test('returns null when config is incomplete', async () => {
    expect(await buildAdapter({}).fetchDeviceBreakdown({ startMs: 0, endMs: 0 })).toBeNull();
    expect(global.fetch).toBe(ORIGINAL_FETCH);
  });

  test('builds the expected URL + sends Bearer auth', async () => {
    mockJson([{ device: 'desktop', sessions: 10 }]);
    await buildAdapter({ ...valid, baseUrl: 'https://r.example.com/' })
      .fetchDeviceBreakdown({ startMs: 1700000000000, endMs: 1700003600000 });
    const [calledUrl, init] = global.fetch.mock.calls[0];
    expect(calledUrl).toMatch(/^https:\/\/r\.example\.com\/api\/site\/rsite-789\/breakdown\?dimension=device&start=.*&end=.*$/);
    expect(init.headers.Authorization).toBe('Bearer rkey');
    expect(init.method).toBe('GET');
  });

  test('URL-encodes the websiteId for reserved chars', async () => {
    mockJson([{ device: 'desktop', sessions: 1 }]);
    await buildAdapter({ ...valid, websiteId: 'a/b?c' }).fetchDeviceBreakdown({ startMs: 0, endMs: 0 });
    const [calledUrl] = global.fetch.mock.calls[0];
    expect(calledUrl).toContain('/api/site/a%2Fb%3Fc/breakdown');
  });

  test('normalises a typical {device, sessions} payload into percentages', async () => {
    mockJson([
      { device: 'desktop', sessions: 60 },
      { device: 'mobile', sessions: 30 },
      { device: 'tablet', sessions: 10 },
    ]);
    expect(await buildAdapter(valid).fetchDeviceBreakdown({ startMs: 0, endMs: 0 }))
      .toEqual({ desktop: 60, mobile: 30, tablet: 10 });
  });

  test('accepts the {data: [...]} envelope variant', async () => {
    mockJson({ data: [
      { device: 'desktop', sessions: 1 },
      { device: 'mobile', sessions: 3 },
    ] });
    expect(await buildAdapter(valid).fetchDeviceBreakdown({ startMs: 0, endMs: 0 }))
      .toEqual({ desktop: 25, mobile: 75, tablet: 0 });
  });

  test('falls back to `visitors` when `sessions` is absent', async () => {
    mockJson([
      { device: 'desktop', visitors: 80 },
      { device: 'mobile', visitors: 20 },
    ]);
    expect(await buildAdapter(valid).fetchDeviceBreakdown({ startMs: 0, endMs: 0 }))
      .toEqual({ desktop: 80, mobile: 20, tablet: 0 });
  });

  test('tolerates a `dimension` key as the bucket label', async () => {
    mockJson([
      { dimension: 'desktop', sessions: 50 },
      { dimension: 'mobile', sessions: 50 },
    ]);
    expect(await buildAdapter(valid).fetchDeviceBreakdown({ startMs: 0, endMs: 0 }))
      .toEqual({ desktop: 50, mobile: 50, tablet: 0 });
  });

  test('drops unknown buckets', async () => {
    mockJson([
      { device: 'desktop', sessions: 80 },
      { device: 'mobile', sessions: 20 },
      { device: 'fridge', sessions: 100 },
    ]);
    expect(await buildAdapter(valid).fetchDeviceBreakdown({ startMs: 0, endMs: 0 }))
      .toEqual({ desktop: 80, mobile: 20, tablet: 0 });
  });

  test('returns null on empty payload, non-2xx, invalid JSON, and network error', async () => {
    mockJson([]);
    expect(await buildAdapter(valid).fetchDeviceBreakdown({ startMs: 0, endMs: 0 })).toBeNull();

    mockJson({ error: 'unauthorized' }, { status: 401 });
    expect(await buildAdapter(valid).fetchDeviceBreakdown({ startMs: 0, endMs: 0 })).toBeNull();

    global.fetch = jest.fn(async () => ({
      ok: true, status: 200,
      json: async () => { throw new SyntaxError('not json'); },
    }));
    expect(await buildAdapter(valid).fetchDeviceBreakdown({ startMs: 0, endMs: 0 })).toBeNull();

    global.fetch = jest.fn(async () => { throw new Error('ECONNREFUSED'); });
    expect(await buildAdapter(valid).fetchDeviceBreakdown({ startMs: 0, endMs: 0 })).toBeNull();
  });
});
