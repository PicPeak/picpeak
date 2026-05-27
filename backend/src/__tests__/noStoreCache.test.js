/**
 * Unit test for the noStoreCache middleware (#470 follow-up).
 *
 * The middleware exists because of a real production-class bug: when
 * #458 mounted a 410-returning kill-switch in front of customer
 * endpoints, browsers cached the 410 (no Cache-Control was set) and
 * kept serving it after #470 reverted the middleware. This test pins
 * the contract so a future cleanup pass doesn't quietly drop the
 * header set and re-introduce the bug.
 */

const { noStoreCache } = require('../middleware/noStoreCache');

function makeRes() {
  const headers = {};
  return {
    setHeader: (k, v) => { headers[k] = v; },
    headers,
  };
}

describe('noStoreCache middleware', () => {
  it('sets Cache-Control: no-store + private and calls next()', () => {
    const res = makeRes();
    const next = jest.fn();

    noStoreCache({}, res, next);

    expect(res.headers['Cache-Control']).toBe(
      'no-store, no-cache, must-revalidate, private',
    );
    // HTTP/1.0 fallbacks — old proxies in front of customer-facing
    // surfaces (corporate VPN gateways, legacy CDNs) honour these.
    expect(res.headers.Pragma).toBe('no-cache');
    expect(res.headers.Expires).toBe('0');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('runs as middleware regardless of response status', () => {
    // The header must land on EVERY response coming from the route
    // group — including 4xx/5xx — so a stale 410 from a
    // now-reverted middleware can't get pinned in browser cache like
    // it did in the #458 → #470 sequence.
    const res = makeRes();
    noStoreCache({}, res, () => {});
    expect(res.headers['Cache-Control']).toContain('no-store');
  });
});
